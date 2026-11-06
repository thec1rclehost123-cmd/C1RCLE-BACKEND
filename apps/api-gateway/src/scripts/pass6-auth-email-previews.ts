import { mkdir, writeFile } from 'node:fs/promises';

import { ResendEmailSender } from '../lib/notifications/resend-email-sender.js';

const PREVIEW_DIR = new URL('../../../../docs/pass6/previews/', import.meta.url);
const INDEX_PATH = new URL('../EMAIL_AUTH_VISUAL_ACCEPTANCE.md', PREVIEW_DIR);
const RECIPIENT = 'auth-preview@synthetic.test';
const SENDER = 'THE C1RCLE <hello@thec1rcle.com>';
const PREVIEW_FILES = [
  'auth-otp',
  'auth-password-reset',
  'auth-staff-invitation',
  'auth-onboarding-changes',
] as const;

interface CapturedMessage {
  name: string;
  subject: string;
  html: string;
  text: string;
}

const messages: CapturedMessage[] = [];
function nameLastMessage(name: string): void {
  const last = messages.at(-1);
  if (!last) throw new Error('Expected a captured synthetic auth email.');
  last.name = name;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  if (typeof init?.body !== 'string')
    throw new Error('Expected serialized synthetic preview email.');
  const payload = JSON.parse(init.body) as Record<string, unknown>;
  if (
    payload.from !== SENDER ||
    payload.to !== RECIPIENT ||
    typeof payload.subject !== 'string' ||
    typeof payload.html !== 'string' ||
    typeof payload.text !== 'string'
  ) {
    throw new Error('Auth preview payload failed synthetic recipient/sender/content checks.');
  }
  const url =
    typeof _input === 'string' ? _input : _input instanceof URL ? _input.href : _input.url;
  if (url !== 'https://api.resend.com/emails') throw new Error('Unexpected preview request URL.');
  messages.push({
    name: '',
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  });
  return new Response(JSON.stringify({ id: `synthetic-auth-preview-${messages.length}` }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

const sender = new ResendEmailSender(
  'synthetic-preview-only-key',
  'production',
  { info() {}, warn() {}, error() {} },
  SENDER,
  RECIPIENT,
  true,
);

try {
  await sender.sendOtpEmail(RECIPIENT, '123456');
  nameLastMessage('OTP / email verification');
  await sender.sendPasswordResetEmail(
    RECIPIENT,
    'https://account.example.test/reset?token=SYNTHETIC-ONLY',
  );
  nameLastMessage('Password reset');
  await sender.sendStaffInvitationEmail({
    to: RECIPIENT,
    orgName: 'Neon Nights Synthetic Venue',
    role: 'manager',
    capabilities: ['event:read', 'ticket:scan'],
    expiresAt: 'July 18, 2026 at 10:00 PM IST',
    temporaryPassword: 'SYNTHETIC-ONLY-CHANGE-ME',
    acceptUrl: 'https://partners.example.test/invitations/SYNTHETIC-ONLY',
  });
  nameLastMessage('Staff invitation');
  await sender.sendOnboardingChangesRequestedEmail(RECIPIENT, {
    legalName: 'Synthetic Applicant',
    note: 'Please add the venue entrance details.',
  });
  nameLastMessage('Partner application changes requested');
} finally {
  globalThis.fetch = originalFetch;
}

if (messages.length !== 4)
  throw new Error(`Expected 4 auth previews, captured ${messages.length}.`);

await mkdir(PREVIEW_DIR, { recursive: true });
for (const [index, message] of messages.entries()) {
  const file = PREVIEW_FILES[index];
  if (!file) throw new Error(`Missing auth preview file name at index ${index}.`);
  await writeFile(new URL(`${file}.html`, PREVIEW_DIR), message.html, 'utf8');
  await writeFile(new URL(`${file}.txt`, PREVIEW_DIR), message.text, 'utf8');
}
const rows = messages
  .map((message, index) => {
    const file = PREVIEW_FILES[index];
    if (!file) throw new Error(`Missing auth preview file name at index ${index}.`);
    return `- **${message.name}** — ${message.subject} ([HTML](./previews/${file}.html), [text](./previews/${file}.txt))`;
  })
  .join('\n');
await writeFile(
  INDEX_PATH,
  `# Pass 6 auth email visual acceptance\n\nThese four previews were rendered by the actual ResendEmailSender methods with synthetic-only data and a request interceptor. The interceptor replaced fetch before any network request. The configured recipient is synthetic, the API key is a nonfunctional placeholder, and no provider request or application mutation occurred.\n\nReview both mobile-width and desktop-width rendering in your mail client or HTML viewer. The source uses a fluid outer table and a 520px maximum-width content frame. OTP, password-reset, invitation URL, and temporary-password values are synthetic placeholders only.\n\n${rows}\n`,
  'utf8',
);
process.stdout.write(
  `Generated ${messages.length} synthetic auth email previews; network egress: false.\n`,
);
