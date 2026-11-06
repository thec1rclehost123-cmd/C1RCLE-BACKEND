/* eslint-disable no-restricted-syntax -- Loopback-only disposable fixture setup/cleanup; never registered as a production service. */
import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';

export async function createPartnerRefinementFixture(
  options: {
    readonly browserOrigins?: readonly string[];
  } = {},
) {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
    throw new Error('Loopback Firestore Emulator required');
  const projectId = `demo-c1rcle-partner-ui-${randomUUID().slice(0, 8)}`;
  const browserOrigins = [
    ...new Set(['http://localhost:3100', ...(options.browserOrigins ?? [])]),
  ].join(',');
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const overrides = {
    NODE_ENV: 'test',
    STORAGE_DRIVER: 'firestore',
    BACKGROUND_WORKERS_ENABLED: 'false',
    PAYOUTS_ENABLED: 'false',
    FIRESTORE_PROJECT_ID: projectId,
    FIREBASE_CLIENT_EMAIL: 'fixture@example.invalid',
    FIREBASE_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    BETTER_AUTH_SECRET: 'synthetic-profile-privacy-secret-at-least-32',
    BETTER_AUTH_URL: 'http://localhost:4301',
    PUBLIC_API_URL: 'http://localhost:4301',
    CORS_ALLOWED_ORIGINS: browserOrigins,
    BETTER_AUTH_TRUSTED_ORIGINS: browserOrigins,
    LOG_LEVEL: 'silent',
  };
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
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
    Reflect.deleteProperty(process.env, key);
  const { buildApp } = await import('../app.js');
  const { createV2Services } = await import('../lib/v2-services.js');
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
      for (const collection of await db.listCollections()) {
        await db.recursiveDelete(collection);
      }
      await db.terminate();
    },
  };
}
