import { randomUUID } from 'node:crypto';

import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import type { EmailSender } from '@c1rcle/core/domain';

import { getGatewayConfig } from '../config/index.js';

import { buildBetterAuth } from './auth.js';

import type { BetterAuthInstance } from './auth.js';

/**
 * ─── The real Better Auth, on a real Firestore (emulator) ───────────────────
 * Every other auth test in this repo injects a FAKE `auth` object (see
 * `routes/v2/auth/index.test.ts`), and the memory driver never builds Better
 * Auth at all, so nothing else in CI runs the library. A dependency upgrade
 * that broke sign-in would therefore pass every other check. This file drives
 * the instance the gateway actually builds (`buildBetterAuth`) through the
 * flows the gateway depends on: sign-up, sign-in, sessions by cookie and by
 * bearer token, password change and password reset.
 *
 * Needs the Firestore emulator, like the core `*.integration.test.ts` files, so
 * it is skipped in a plain `pnpm test` and run by the CI emulator job:
 *   firebase emulators:exec --only firestore --project demo-c1rcle \
 *     "pnpm --filter api-gateway exec vitest run src/plugins/auth.firestore.integration.test.ts"
 */

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const PASSWORD = 'correct-horse-battery-1';

interface CapturedEmails {
  resetUrls: Map<string, string>;
}

function captureEmailSender(captured: CapturedEmails): EmailSender {
  return {
    name: 'test-capture',
    sendOtpEmail: () => Promise.resolve(),
    sendStaffInvitationEmail: () => Promise.resolve(),
    sendOnboardingChangesRequestedEmail: () => Promise.resolve(),
    sendPasswordResetEmail: (recipient, resetUrl) => {
      captured.resetUrls.set(recipient, resetUrl);
      return Promise.resolve();
    },
  };
}

function cookieOf(response: Response): string {
  const cookie = response.headers.getSetCookie()[0];
  if (cookie === undefined) throw new Error('response set no cookie');
  return cookie.split(';')[0] ?? '';
}

function uniqueEmail(label: string): string {
  return `${label}-${randomUUID()}@example.test`;
}

describe.runIf(EMULATOR)('Better Auth on Firestore (emulator)', () => {
  let db: Firestore;
  let auth: BetterAuthInstance;
  const captured: CapturedEmails = { resetUrls: new Map() };

  beforeAll(() => {
    db = new Firestore({ projectId: 'demo-c1rcle' });
    const gateway = getGatewayConfig({
      NODE_ENV: 'test',
      STORAGE_DRIVER: 'memory',
      TRUSTED_PROXY_CIDRS: '127.0.0.1',
      ALLOWED_ORIGINS: 'http://localhost:3000',
      BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3000',
    });
    auth = buildBetterAuth(gateway, db, captureEmailSender(captured));
  });

  async function signUp(email: string) {
    return auth.api.signUpEmail({
      body: { email, password: PASSWORD, name: 'Test Partner', role: 'partner' },
      headers: new Headers(),
      asResponse: true,
    });
  }

  async function signIn(email: string, password: string) {
    return auth.api.signInEmail({
      body: { email, password },
      headers: new Headers(),
      asResponse: true,
    });
  }

  it('signs up, then reads the session by cookie and by bearer token', async () => {
    const email = uniqueEmail('signup');
    const response = await signUp(email);
    expect(response.ok).toBe(true);

    const bearer = response.headers.get('set-auth-token');
    expect(bearer).toBeTruthy();

    const byCookie = await auth.api.getSession({
      headers: new Headers({ cookie: cookieOf(response) }),
    });
    expect(byCookie?.user.email).toBe(email);
    expect((byCookie?.user as { role?: string } | undefined)?.role).toBe('partner');

    const byBearer = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${bearer ?? ''}` }),
    });
    expect(byBearer?.user.email).toBe(email);
  });

  it('signs in with the right password and rejects the wrong one', async () => {
    const email = uniqueEmail('signin');
    expect((await signUp(email)).ok).toBe(true);

    const good = await signIn(email, PASSWORD);
    expect(good.ok).toBe(true);
    expect(good.headers.getSetCookie().length).toBeGreaterThan(0);

    const bad = await signIn(email, 'not-the-password-1');
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(401);

    const unknown = await signIn(uniqueEmail('nobody'), PASSWORD);
    expect(unknown.ok).toBe(false);
  });

  it('stores one credential account per user, keyed by the user id', async () => {
    const email = uniqueEmail('account');
    const response = await signUp(email);
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookieOf(response) }),
    });
    const userId = session?.user.id ?? '';
    expect(userId).not.toBe('');

    const snapshot = await db.collection('v2_auth_accounts').where('userId', '==', userId).get();
    expect(snapshot.size).toBe(1);
    const account = snapshot.docs[0]?.data() ?? {};
    expect(account.providerId).toBe('credential');
    // The 1.7 upgrade guide's backfill rule for credential accounts: accountId is the
    // linked user's id. A change in how accounts are keyed would break that backfill.
    expect(account.accountId).toBe(userId);
    expect(typeof account.password).toBe('string');
  });

  it('changes a password, revokes the old session and signs in with the new one', async () => {
    const email = uniqueEmail('change');
    const response = await signUp(email);
    const cookie = cookieOf(response);

    await auth.api.changePassword({
      body: {
        currentPassword: PASSWORD,
        newPassword: 'a-brand-new-password-2',
        revokeOtherSessions: true,
      },
      headers: new Headers({ cookie }),
    });

    expect((await signIn(email, PASSWORD)).ok).toBe(false);
    expect((await signIn(email, 'a-brand-new-password-2')).ok).toBe(true);
    // revokeOtherSessions is what the gateway relies on after a temporary password.
    const revoked = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(revoked).toBeNull();
  });

  it('resets a forgotten password through the emailed link', async () => {
    const email = uniqueEmail('reset');
    expect((await signUp(email)).ok).toBe(true);

    await auth.api.requestPasswordReset({ body: { email }, headers: new Headers() });
    const url = captured.resetUrls.get(email);
    expect(url).toBeTruthy();
    const token = new URL(url ?? '').pathname.split('/').pop() ?? '';
    expect(token.length).toBeGreaterThan(10);

    await auth.api.resetPassword({
      body: { newPassword: 'reset-password-value-3', token },
      headers: new Headers(),
    });
    expect((await signIn(email, 'reset-password-value-3')).ok).toBe(true);
    expect((await signIn(email, PASSWORD)).ok).toBe(false);
  });

  it('keeps working for a credential account document that has no issuer field', async () => {
    // The 1.7 upgrade guide says every account needs an `issuer` backfilled, but it is
    // written for SQL schemas with a required column. On this Firestore adapter 1.7
    // writes no issuer for credential accounts and accepts documents without one, which
    // is also the shape every account created before the upgrade has. This test pins
    // that: if a later version starts requiring the field, existing users would be
    // locked out and this is the test that must fail first.
    const email = uniqueEmail('legacy');
    const response = await signUp(email);
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookieOf(response) }),
    });
    const userId = session?.user.id ?? '';

    const snapshot = await db.collection('v2_auth_accounts').where('userId', '==', userId).get();
    const ref = snapshot.docs[0]?.ref;
    expect(ref).toBeDefined();
    await ref?.update({ issuer: FieldValue.delete() });
    expect((await ref?.get())?.data()?.issuer).toBeUndefined();

    expect((await signIn(email, PASSWORD)).ok).toBe(true);
    expect((await signIn(email, 'not-the-password-1')).status).toBe(401);
    // A second sign-up for the same address must still be refused, not create a duplicate.
    expect((await signUp(email)).ok).toBe(false);

    const cookie = cookieOf(await signIn(email, PASSWORD));
    await auth.api.changePassword({
      body: { currentPassword: PASSWORD, newPassword: 'legacy-new-password-4' },
      headers: new Headers({ cookie }),
    });
    expect((await signIn(email, 'legacy-new-password-4')).ok).toBe(true);
  });

  it('answers a reset request for an unknown address without an error', async () => {
    const result = await auth.api.requestPasswordReset({
      body: { email: uniqueEmail('ghost') },
      headers: new Headers(),
    });
    expect(result.status).toBe(true);
  });
});
