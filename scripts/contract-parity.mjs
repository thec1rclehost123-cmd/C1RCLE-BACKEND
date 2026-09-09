/**
 * ─── Frontend ↔ backend contract parity (B02 / B13) ──────────────────────────
 *
 * Two repos, one wire contract. `C1RCLE-FRONTEND` owns `@c1rcle/types` +
 * `@c1rcle/api-client`; this repo owns `packages/contracts`. Nothing is
 * published yet, so drift is caught here instead of in production.
 *
 * The check is **behavioural, not textual**: every fixture below is parsed by
 * BOTH the frontend schema and the backend schema, and the two must agree on
 * accept/reject. A formatting change can never fail this; a real constraint
 * change always will.
 *
 * Usage:  node scripts/contract-parity.mjs [--frontend <path>]
 * Exit 0 = contracts agree. Exit 1 = drift (CI fails). Exit 2 = cannot check.
 */
import { existsSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The frontend's compiled schemas import a bare `zod`, which they cannot
 * resolve from outside their own workspace. Redirect that specifier to this
 * repo's zod. Both sides then build their schemas with the SAME zod build, so
 * any disagreement below is a real constraint difference rather than a
 * version artefact — which is exactly the comparison we want.
 */
// Resolved from the contracts package, which is the workspace that declares zod.
const zodRequire = createRequire(join(ROOT, 'packages/contracts/package.json'));
const zodUrl = pathToFileURL(zodRequire.resolve('zod')).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'zod') return { url: zodUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

function frontendRoot() {
  const flagIndex = process.argv.indexOf('--frontend');
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return resolve(process.argv[flagIndex + 1]);
  }
  if (process.env.C1RCLE_FRONTEND_PATH) return resolve(process.env.C1RCLE_FRONTEND_PATH);
  return resolve(ROOT, '..', 'C1RCLE-FRONTEND');
}

const FRONTEND = frontendRoot();

/*
 * The frontend wire contract lives in its own generated package,
 * `<frontend>/packages/contracts` (spec §5 — mirrored from this repo by
 * `scripts/export-contracts.mjs`, built to `dist/` because Next does not
 * transpile workspace TS). Its `./client` entry mirrors this repo's
 * `packages/contracts/src/client.ts` export-for-export, so it is what we read.
 *
 * Before Phase 2 that package does not exist. The pre-Phase-2 home for the
 * shared schemas was `packages/api-client/dist/schemas.js`, but it only ever
 * carried role / user / session / pagination — not the auth-bridge, onboarding,
 * organization or partner schemas this check now covers. So when the contracts
 * package is absent we cannot run a meaningful check: exit 2 ("cannot check"),
 * never a crash.
 */
const FE_CONTRACTS_DIR = join(FRONTEND, 'packages/contracts/dist');
const FE_CONTRACTS_MAIN = join(FE_CONTRACTS_DIR, 'index.js');
const FE_CONTRACTS_CLIENT = join(FE_CONTRACTS_DIR, 'client.js');
const FE_APICLIENT_SCHEMAS = join(FRONTEND, 'packages/api-client/dist/schemas.js'); // pre-Phase-2 (legacy)
const FRONTEND_ERRORS = join(FRONTEND, 'packages/api-client/dist/errors.js');

if (!existsSync(FE_CONTRACTS_MAIN) || !existsSync(FE_CONTRACTS_CLIENT)) {
  console.error('Contract parity: the frontend @c1rcle/contracts package is not built yet.');
  console.error(`  expected: ${FE_CONTRACTS_CLIENT}`);
  console.error(`  frontend root: ${FRONTEND}  (--frontend <path> or C1RCLE_FRONTEND_PATH)`);
  console.error('  This lands in Phase 2 — scaffold packages/contracts, then:');
  console.error('    node ../C1RCLE-BACKEND/scripts/export-contracts.mjs --frontend .');
  console.error('    pnpm --filter @c1rcle/contracts build');
  if (existsSync(FE_APICLIENT_SCHEMAS)) {
    console.error(`  (legacy ${FE_APICLIENT_SCHEMAS} exists but predates these schemas.)`);
  }
  process.exit(2);
}

if (!existsSync(FRONTEND_ERRORS)) {
  console.error('Contract parity: cannot locate the frontend error module.');
  console.error(`  expected: ${FRONTEND_ERRORS}  (build: pnpm --filter @c1rcle/api-client build)`);
  process.exit(2);
}

/*
 * Both sides are read from BUILT output. This repo's `packages/contracts/src`
 * uses NodeNext `.js` import specifiers that plain `node` cannot resolve back to
 * `.ts` under type-stripping, so the check reads `packages/contracts/dist`
 * instead — symmetric with the frontend (also `dist`), and it means the check
 * validates exactly what a consumer resolves.
 */
const BACKEND_DIR = join(ROOT, 'packages/contracts/dist');
const BACKEND_CLIENT = join(BACKEND_DIR, 'client.js');
const BACKEND_INDEX = join(BACKEND_DIR, 'index.js');
if (!existsSync(BACKEND_CLIENT) || !existsSync(BACKEND_INDEX)) {
  console.error('Contract parity: packages/contracts is not built.');
  console.error(`  expected: ${BACKEND_CLIENT}`);
  console.error('  build it: pnpm --filter @c1rcle/contracts build');
  process.exit(2);
}

const FRONTEND_SCHEMAS = FE_CONTRACTS_CLIENT;

const frontend = await import(pathToFileURL(FRONTEND_SCHEMAS).href);
const frontendErrors = await import(pathToFileURL(FRONTEND_ERRORS).href);
const backend = await import(pathToFileURL(BACKEND_CLIENT).href);
const backendEnvelope = await import(pathToFileURL(BACKEND_INDEX).href);

const failures = [];
const checks = [];

/** Asserts both schemas reach the same verdict on one fixture. */
function agree(schemaName, label, value, expected) {
  const front = frontend[schemaName];
  const back = backend[schemaName];
  if (!front) {
    failures.push(`frontend is missing schema \`${schemaName}\``);
    return;
  }
  if (!back) {
    failures.push(`backend packages/contracts is missing schema \`${schemaName}\``);
    return;
  }
  const frontOk = front.safeParse(value).success;
  const backOk = back.safeParse(value).success;
  checks.push(`${schemaName}: ${label}`);

  if (frontOk !== backOk) {
    failures.push(
      `DRIFT ${schemaName} — "${label}": frontend ${frontOk ? 'accepts' : 'rejects'}, ` +
        `backend ${backOk ? 'accepts' : 'rejects'}`,
    );
    return;
  }
  if (frontOk !== expected) {
    failures.push(
      `BOTH WRONG ${schemaName} — "${label}": expected ${expected ? 'accept' : 'reject'}, ` +
        `both ${frontOk ? 'accepted' : 'rejected'}`,
    );
  }
}

const VALID_USER = {
  id: 'usr_1',
  email: 'partner@example.com',
  displayName: 'Sky Partner',
  role: 'partner',
  avatarUrl: null,
};

/* ── role ─────────────────────────────────────────────────────────────────── */
for (const role of ['guest', 'partner', 'admin']) {
  agree('roleSchema', `accepts ${role}`, role, true);
}
agree('roleSchema', 'rejects an unknown role', 'superadmin', false);
agree('roleSchema', 'rejects a non-string', 3, false);

/* ── user ─────────────────────────────────────────────────────────────────── */
agree('userSchema', 'accepts the canonical user', VALID_USER, true);
agree(
  'userSchema',
  'accepts an https avatar',
  { ...VALID_USER, avatarUrl: 'https://cdn.example.com/a.png' },
  true,
);
agree('userSchema', 'rejects a malformed email', { ...VALID_USER, email: 'not-an-email' }, false);
agree('userSchema', 'rejects a non-url avatar', { ...VALID_USER, avatarUrl: 'nope' }, false);
agree(
  'userSchema',
  'rejects a missing displayName',
  { ...VALID_USER, displayName: undefined },
  false,
);
agree('userSchema', 'rejects an unknown role', { ...VALID_USER, role: 'owner' }, false);

/* ── session ──────────────────────────────────────────────────────────────── */
agree(
  'sessionSchema',
  'accepts user + epoch ms',
  { user: VALID_USER, expiresAt: 1_800_000_000_000 },
  true,
);
agree(
  'sessionSchema',
  'rejects an ISO string expiry (epoch ms is the contract)',
  { user: VALID_USER, expiresAt: '2026-08-11T00:00:00Z' },
  false,
);
agree('sessionSchema', 'rejects a missing user', { expiresAt: 1 }, false);

/* ── pagination ───────────────────────────────────────────────────────────── */
const VALID_PAGE_INFO = { page: 1, pageSize: 20, total: 3, hasNextPage: false };
agree('pageInfoSchema', 'accepts the canonical page info', VALID_PAGE_INFO, true);
agree(
  'pageInfoSchema',
  'rejects a missing hasNextPage',
  { page: 1, pageSize: 20, total: 3 },
  false,
);
agree('pageInfoSchema', 'rejects a string page', { ...VALID_PAGE_INFO, page: '1' }, false);

/* ── 204 semantics ────────────────────────────────────────────────────────── */
agree('noContentSchema', 'accepts undefined (204, no body)', undefined, true);
agree('noContentSchema', 'rejects a body', {}, false);

/* ── paginated<T> (function, checked separately) ──────────────────────────── */
{
  const { z } = await import(zodUrl);
  const itemSchema = z.object({ id: z.string() });
  const item = { id: 'x' };
  const frontPaginated = frontend.paginatedSchema(itemSchema);
  const backPaginated = backend.paginatedSchema(itemSchema);
  const good = { items: [item], pageInfo: VALID_PAGE_INFO };
  const bad = { items: [item] };
  for (const [label, value, expected] of [
    ['accepts items + pageInfo', good, true],
    ['rejects a missing pageInfo', bad, false],
  ]) {
    const frontOk = frontPaginated.safeParse(value).success;
    const backOk = backPaginated.safeParse(value).success;
    checks.push(`paginatedSchema: ${label}`);
    if (frontOk !== backOk) {
      failures.push(
        `DRIFT paginatedSchema — "${label}": frontend ${frontOk ? 'accepts' : 'rejects'}, ` +
          `backend ${backOk ? 'accepts' : 'rejects'}`,
      );
    } else if (frontOk !== expected) {
      failures.push(`BOTH WRONG paginatedSchema — "${label}"`);
    }
  }
}

/* ── auth bridge ({user, accessToken, expiresAt}) ─────────────────────────── */
const VALID_AUTH_BRIDGE = {
  user: VALID_USER,
  accessToken: 'session_tok_abcdef',
  expiresAt: 1_800_000_000_000,
};
agree(
  'authBridgeResponseSchema',
  'accepts user + token + epoch-ms expiry',
  VALID_AUTH_BRIDGE,
  true,
);
agree(
  'authBridgeResponseSchema',
  'accepts another epoch-ms expiry',
  { ...VALID_AUTH_BRIDGE, expiresAt: 1_723_000_000_000 },
  true,
);
agree(
  'authBridgeResponseSchema',
  'rejects an ISO-string expiry (epoch ms is the contract)',
  { ...VALID_AUTH_BRIDGE, expiresAt: '2026-08-11T00:00:00Z' },
  false,
);
agree(
  'authBridgeResponseSchema',
  'rejects a missing accessToken',
  { user: VALID_USER, expiresAt: 1_800_000_000_000 },
  false,
);
agree(
  'authBridgeResponseSchema',
  'rejects an empty accessToken',
  { ...VALID_AUTH_BRIDGE, accessToken: '' },
  false,
);

/* ── signup / login requests — both .strict(), neither carries `role` ─────── */
const VALID_SIGNUP = {
  email: 'partner@example.com',
  password: 'corr3ct-horse',
  displayName: 'Sky Partner',
};
agree('signupRequestSchema', 'accepts a well-formed signup', VALID_SIGNUP, true);
agree(
  'signupRequestSchema',
  'rejects a password under 8 chars',
  { ...VALID_SIGNUP, password: 'short' },
  false,
);
agree(
  'signupRequestSchema',
  'rejects an extra `role` key (.strict)',
  { ...VALID_SIGNUP, role: 'admin' },
  false,
);
agree(
  'signupRequestSchema',
  'rejects an unknown key (.strict)',
  { ...VALID_SIGNUP, nickname: 'sky' },
  false,
);

const VALID_LOGIN = { email: 'partner@example.com', password: 'corr3ct-horse' };
agree('loginRequestSchema', 'accepts a well-formed login', VALID_LOGIN, true);
agree('loginRequestSchema', 'rejects an empty password', { ...VALID_LOGIN, password: '' }, false);
agree(
  'loginRequestSchema',
  'rejects an extra `role` key (.strict)',
  { ...VALID_LOGIN, role: 'admin' },
  false,
);
agree(
  'loginRequestSchema',
  'rejects an unknown key (.strict)',
  { ...VALID_LOGIN, remember: true },
  false,
);

/* ── onboarding profile — .strict(), `role` stripped at the boundary ─────── */
const VALID_ONBOARDING_PROFILE = {
  legalName: 'Neon Room Hospitality LLP',
  contactPerson: 'Asha Menon',
  phone: '+91 22 1234 5678',
  city: 'Mumbai',
};
agree('onboardingProfileSchema', 'accepts the required minimum', VALID_ONBOARDING_PROFILE, true);
agree(
  'onboardingProfileSchema',
  'accepts the optional fields too',
  { ...VALID_ONBOARDING_PROFILE, area: 'Bandra', capacity: 300, instagram: '@neonroom' },
  true,
);
agree(
  'onboardingProfileSchema',
  'rejects a `role` key (privilege-escalation guard)',
  { ...VALID_ONBOARDING_PROFILE, role: 'host' },
  false,
);
agree(
  'onboardingProfileSchema',
  'rejects an unknown key (.strict)',
  { ...VALID_ONBOARDING_PROFILE, plan: 'basic' },
  false,
);
agree(
  'onboardingProfileSchema',
  'rejects a missing required field (city)',
  { legalName: 'X Co', contactPerson: 'Y', phone: '123456' },
  false,
);

/* ── onboarding request DTO ──────────────────────────────────────────────── */
const ISO = '2026-08-27T10:00:00Z';
const VALID_ONBOARDING_REQUEST = {
  id: 'onb_1',
  userId: 'usr_1',
  status: 'draft',
  requestedType: 'venue',
  plan: 'basic',
  profile: VALID_ONBOARDING_PROFILE,
  documents: [],
  missingDocuments: ['id_front', 'id_back', 'selfie'],
  submittedAt: null,
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  provisionedOrganizationId: null,
  version: 1,
  createdAt: ISO,
  updatedAt: ISO,
};
agree(
  'onboardingRequestDtoSchema',
  'accepts a canonical draft request',
  VALID_ONBOARDING_REQUEST,
  true,
);
agree(
  'onboardingRequestDtoSchema',
  'rejects a legacy `pending` status (V2 renamed it `submitted`)',
  { ...VALID_ONBOARDING_REQUEST, status: 'pending' },
  false,
);

/* ── organization DTO ───────────────────────────────────────────────────── */
const VALID_ORGANIZATION = {
  id: 'org_1',
  name: 'Neon Room',
  slug: 'neon-room',
  role: 'owner',
  status: 'active',
  version: 1,
  createdAt: ISO,
  updatedAt: ISO,
};
agree('organizationDtoSchema', 'accepts a canonical organization', VALID_ORGANIZATION, true);
agree(
  'organizationDtoSchema',
  'rejects an out-of-enum status',
  { ...VALID_ORGANIZATION, status: 'pending' },
  false,
);

/* ── public SEO detail projections ──────────────────────────────────────── */
const VALID_PUBLIC_VENUE = {
  id: 'ven_1',
  organizationId: 'org_1',
  name: 'Neon Room',
  slug: 'neon-room',
  status: 'active',
  description: 'A public venue description.',
  capacity: 300,
  city: 'Mumbai',
  photoUrl: 'https://images.example.test/venue.webp',
  address: { city: 'Mumbai', state: 'Maharashtra', country: 'IN' },
  facilities: ['stage'],
  version: 1,
  createdAt: ISO,
  updatedAt: ISO,
};
agree(
  'venuePublicDetailDtoSchema',
  'accepts authoritative public profile fields',
  VALID_PUBLIC_VENUE,
  true,
);
agree(
  'venuePublicDetailDtoSchema',
  'rejects a malformed public photo URL',
  { ...VALID_PUBLIC_VENUE, photoUrl: 'not-a-url' },
  false,
);

const VALID_PUBLIC_EVENT_DETAIL = {
  id: 'evt_1',
  organizationId: 'org_1',
  venueId: 'ven_1',
  slug: 'neon-night',
  title: 'Neon Night',
  summary: 'A public event summary.',
  description: '',
  imageUrl: 'https://images.example.test/event.webp',
  startAt: ISO,
  endAt: null,
  status: 'published',
  isPublic: true,
  tags: ['music'],
  startingPricePaise: 5000,
  isFree: false,
  cancellationReason: null,
  version: 1,
  createdAt: ISO,
  updatedAt: ISO,
  venue: {
    id: 'ven_1',
    name: 'Neon Room',
    slug: 'neon-room',
    photoUrl: VALID_PUBLIC_VENUE.photoUrl,
    address: VALID_PUBLIC_VENUE.address,
  },
  organizer: { id: 'org_1', name: 'Neon Host', slug: 'neon-host' },
};
agree(
  'eventPublicDetailDtoSchema',
  'accepts nullable public venue and organizer projections',
  VALID_PUBLIC_EVENT_DETAIL,
  true,
);
agree(
  'eventPublicDetailDtoSchema',
  'rejects an invalid organizer slug',
  { ...VALID_PUBLIC_EVENT_DETAIL, organizer: { id: 'org_1', name: 'Host', slug: 'Bad Slug' } },
  false,
);

/* ── partner access DTO — the RBAC source ───────────────────────────────── */
const VALID_PARTNER_ACCESS = {
  organizationId: 'org_1',
  userId: 'usr_1',
  partnerType: 'venue',
  role: 'owner',
  permissions: ['MANAGE_EVENTS', 'VIEW_ANALYTICS'],
  tabVisibility: null,
};
agree(
  'partnerAccessDtoSchema',
  'accepts tabVisibility: null (show every tab)',
  VALID_PARTNER_ACCESS,
  true,
);
agree(
  'partnerAccessDtoSchema',
  'accepts an explicit tabVisibility map',
  { ...VALID_PARTNER_ACCESS, tabVisibility: { events: true, finance: false } },
  true,
);
agree(
  'partnerAccessDtoSchema',
  'rejects an unknown permission verb',
  { ...VALID_PARTNER_ACCESS, permissions: ['DO_ANYTHING'] },
  false,
);
agree(
  'partnerAccessDtoSchema',
  'rejects an unknown partnerType',
  { ...VALID_PARTNER_ACCESS, partnerType: 'admin' },
  false,
);

/* ── error envelope: status → code map ────────────────────────────────────── */
for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 418]) {
  const front = frontendErrors.statusToErrorCode(status);
  const back = backendEnvelope.errorCodeForStatus(status);
  checks.push(`errorCodeForStatus: ${status}`);
  // 4xx outside the mapped set is the one deliberate difference: the frontend
  // collapses it to 'unknown', and so must the backend.
  if (front !== back) {
    failures.push(`DRIFT status→code for ${status}: frontend "${front}", backend "${back}"`);
  }
}

/* ── error codes: the closed union must match exactly ─────────────────────── */
{
  const FRONTEND_CODES = [
    'network',
    'timeout',
    'aborted',
    'unauthorized',
    'forbidden',
    'not_found',
    'conflict',
    'validation',
    'rate_limited',
    'server',
    'parse',
    'unknown',
  ];
  // Backend codes are a type, not a value — probe the builder instead.
  const unreachable = FRONTEND_CODES.filter((code) => {
    const body = backendEnvelope.buildV2ErrorResponse({ status: 400, message: 'x', code });
    return body.code !== code;
  });
  checks.push('ApiErrorCode union');
  if (unreachable.length > 0) {
    failures.push(
      `DRIFT error codes unsupported by the backend envelope: ${unreachable.join(', ')}`,
    );
  }
}

/* ── report ───────────────────────────────────────────────────────────────── */
if (failures.length > 0) {
  console.error(`Contract parity: ${failures.length} problem(s) across ${checks.length} checks\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(
    '\nContracts are backend-owned: fix packages/contracts first, then the frontend copy.',
  );
  process.exit(1);
}

console.log(`Contract parity: clean — ${checks.length} checks agree with ${FRONTEND}`);
