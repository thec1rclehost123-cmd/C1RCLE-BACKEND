import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Native auth + real Firestore, restricted to disposable loopback demo data. */
async function createGuestProfilePrivacyFixture() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
    throw new Error('Loopback Firestore Emulator required');
  const projectId = `demo-c1rcle-profile-${randomUUID().slice(0, 8)}`;
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const overrides = {
    NODE_ENV: 'test',
    STORAGE_DRIVER: 'firestore',
    BACKGROUND_WORKERS_ENABLED: 'false',
    FIRESTORE_PROJECT_ID: projectId,
    FIREBASE_CLIENT_EMAIL: 'fixture@example.invalid',
    FIREBASE_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    BETTER_AUTH_SECRET: 'synthetic-profile-privacy-secret-at-least-32',
    BETTER_AUTH_URL: 'http://localhost:4301',
    PUBLIC_API_URL: 'http://localhost:4301',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3100',
    BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3100',
    LOG_LEVEL: 'silent',
  };
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
  // No live outbound providers, including if the invoking shell has credentials.
  for (const key of [
    'RESEND_API_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RAZORPAY_WEBHOOK_SECRET',
  ])
    vi.stubEnv(key, undefined);
  const { buildApp } = await import('../../app.js');
  const { createV2Services } = await import('../../lib/v2-services.js');
  const services = createV2Services();
  services.emailSender.sendOtpEmail = async () => {};
  services.emailSender.sendPasswordResetEmail = async () => {};
  services.emailSender.sendStaffInvitationEmail = async () => {};
  services.emailSender.sendOnboardingChangesRequestedEmail = async () => {};
  const app = await buildApp();
  const db = new Firestore({ projectId, host, ssl: false });
  const accounts: {
    persona: 'guest-a' | 'guest-b' | 'partner';
    id: string;
    email: string;
    password: string;
    headers: { authorization: string };
  }[] = [];
  for (const persona of ['guest-a', 'guest-b', 'partner'] as const) {
    const email = `${persona}@${projectId}.invalid`;
    const password = 'Synthetic-profile-password-16';
    const signup = await app.inject({
      method: 'POST',
      url: `/api/v2/auth/${persona === 'partner' ? 'partner/signup' : 'signup'}`,
      payload: { email, password, displayName: `Synthetic ${persona}` },
    });
    if (signup.statusCode !== 201) throw new Error(`Synthetic signup failed: ${signup.statusCode}`);
    const result = signup.json<{ user: { id: string }; accessToken: string }>();
    await db
      .collection('v2_auth_users')
      .doc(result.user.id)
      .update({
        emailVerified: true,
        ...(persona === 'guest-a' ? { image: 'http://localhost:3100/c1rcle-logo.webp' } : {}),
      });
    accounts.push({
      persona,
      id: result.user.id,
      email,
      password,
      headers: { authorization: `Bearer ${result.accessToken}` },
    });
    if (persona !== 'partner') {
      await services.guestProfile.saveOnboarding(result.user.id, {
        displayName: `Synthetic ${persona}`,
        dateOfBirth: '2000-01-01',
        tastes: ['House'],
      });
      await services.guestProfile.verifyPhone(
        result.user.id,
        persona === 'guest-a' ? '+919000000041' : '+919000000042',
        'synthetic-fixture-proof',
        {
          name: 'synthetic-fixture',
          verify: async () => ({ passed: true, provider: 'firebase-phone' }),
        },
      );
    }
  }
  return {
    app,
    db,
    accounts,
    services,
    projectId,
    async close() {
      await app.close();
      for (const account of accounts) {
        for (const collection of ['v2_auth_accounts', 'v2_auth_sessions']) {
          const docs = await db.collection(collection).where('userId', '==', account.id).get();
          await Promise.all(docs.docs.map((doc) => doc.ref.delete()));
        }
        await db.collection('v2_auth_users').doc(account.id).delete();
        await db.collection('v2_guest_profiles').doc(account.id).delete();
      }
      await db.terminate();
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
describe.runIf(emulator)('Guest profile privacy (native auth + loopback Firestore)', () => {
  it('isolates real Guest/Partner sessions, preserves private onboarding fields, and denies forged identities and revoked sessions', async () => {
    const fixture = await createGuestProfilePrivacyFixture();
    const { app, accounts, db } = fixture;
    const [a, b, partner] = accounts;
    if (!a || !b || !partner) throw new Error('Expected distinct synthetic accounts');
    try {
      const session = await app.inject({
        method: 'GET',
        url: '/api/v2/auth/session',
        headers: a.headers,
      });
      expect(session.statusCode).toBe(200);
      expect(session.json<{ user: { avatarUrl: string } }>().user.avatarUrl).toBe(
        'http://localhost:3100/c1rcle-logo.webp',
      );
      const beforeB = (await db.collection('v2_guest_profiles').doc(b.id).get()).data();
      const getA = await app.inject({
        method: 'GET',
        url: `/api/v2/profile/me?userId=${b.id}`,
        headers: { ...a.headers, 'x-user-id': b.id },
      });
      expect(getA.statusCode).toBe(200);
      expect(getA.headers['cache-control']).toBe('private, no-store');
      expect(getA.json()).toMatchObject({ userId: a.id, phoneNumber: '+919000000041' });
      expect(Object.keys(getA.json<Record<string, unknown>>()).sort()).toEqual(
        [
          'userId',
          'displayName',
          'dateOfBirth',
          'phoneNumber',
          'city',
          'tastes',
          'intents',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
      const body = {
        displayName: 'Updated private Guest',
        dateOfBirth: '2000-01-01',
        city: '',
        tastes: ['House'],
        intents: [],
      };
      const updated = await app.inject({
        method: 'PUT',
        url: '/api/v2/profile/me',
        headers: a.headers,
        payload: body,
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ ...body, userId: a.id, phoneNumber: '+919000000041' });
      for (const forged of [
        { userId: b.id },
        { phoneNumber: '+919999999999' },
        { phoneVerifiedAt: '2026-01-01T00:00:00Z' },
        { role: 'admin' },
        { avatarUrl: 'https://untrusted.invalid/photo' },
        { privacy: 'public' },
        { profile: { userId: b.id } },
      ]) {
        const attack = await app.inject({
          method: 'PUT',
          url: '/api/v2/profile/me',
          headers: a.headers,
          payload: { ...body, ...forged },
        });
        expect(attack.statusCode).toBe(422);
      }
      for (const actor of [a, partner]) {
        const privateRead = await app.inject({
          method: 'GET',
          url: `/api/v2/profile/${b.id}`,
          headers: actor.headers,
        });
        expect(privateRead.statusCode).toBe(404);
        const edit = await app.inject({
          method: 'PUT',
          url: `/api/v2/profile/${b.id}`,
          headers: actor.headers,
          payload: body,
        });
        expect(edit.statusCode).toBe(404);
      }
      const partnerRead = await app.inject({
        method: 'GET',
        url: `/api/v2/profile/me?userId=${b.id}`,
        headers: { ...partner.headers, 'x-user-id': b.id },
      });
      expect(partnerRead.statusCode).toBe(404);
      const ownB = await app.inject({
        method: 'GET',
        url: '/api/v2/profile/me',
        headers: b.headers,
      });
      expect(ownB.statusCode).toBe(200);
      expect(ownB.json()).toMatchObject({
        userId: b.id,
        displayName: 'Synthetic guest-b',
        phoneNumber: '+919000000042',
      });
      expect((await db.collection('v2_guest_profiles').doc(b.id).get()).data()).toEqual(beforeB);
      for (const method of ['GET', 'PUT'] as const) {
        const anonymous = await app.inject({
          method,
          url: '/api/v2/profile/me',
          headers: { 'x-user-id': a.id },
          ...(method === 'PUT' ? { payload: body } : {}),
        });
        expect(anonymous.statusCode).toBe(401);
      }
      const logout = await app.inject({
        method: 'POST',
        url: '/api/v2/auth/logout',
        headers: a.headers,
      });
      expect(logout.statusCode).toBe(204);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v2/profile/me', headers: a.headers }))
          .statusCode,
      ).toBe(401);
    } finally {
      await fixture.close();
    }
  }, 60000);
});
