import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { createEvent } from '@c1rcle/core/domain';
import { FirestoreSavedEventRepository } from '@c1rcle/core/saved-events';
import { Firestore } from 'firebase-admin/firestore';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Native auth + real Firestore, restricted to disposable loopback demo data. */
async function createSavedFixture() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
    throw new Error('Loopback Firestore Emulator required');
  const projectId = `demo-c1rcle-saved-${randomUUID().slice(0, 8)}`;
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
      for (const collection of await db.listCollections()) {
        await db.recursiveDelete(collection);
      }
      await db.terminate();
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
describe.runIf(emulator)('Saved events native auth + Firestore', () => {
  it('persists unique private bookmarks, follows current public event state and never creates attendance', async () => {
    const fixture = await createSavedFixture();
    const { app, accounts, services, db } = fixture;
    const [a, b, partner] = accounts;
    if (!a || !b || !partner) throw new Error('Missing synthetic users');
    const event = {
      ...createEvent({
        id: 'saved-native-event',
        organizationId: 'saved-host',
        venueId: 'synthetic-venue',
        title: 'Synthetic Saved Night',
        startAt: '2099-12-01T18:00:00Z',
      }),
      status: 'published' as const,
      isPublic: true,
    };
    const call = (
      method: 'GET' | 'PUT',
      path: string,
      actor = a,
      payload?: Record<string, unknown>,
      headers = {},
    ) =>
      app.inject({
        method,
        url: `/api/v2/saved-events${path}`,
        headers: { ...actor.headers, ...headers },
        ...(payload === undefined ? {} : { payload }),
      });
    try {
      await services.repos().events.save(event);
      expect((await app.inject({ method: 'GET', url: '/api/v2/saved-events' })).statusCode).toBe(
        401,
      );
      expect((await call('GET', '', partner)).statusCode).toBe(403);
      expect((await call('GET', '', a)).json().items).toEqual([]);
      const concurrent = await Promise.all(
        Array.from({ length: 8 }, () => call('PUT', `/${event.id}`, a, { saved: true })),
      );
      for (const response of concurrent) {
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({ saved: true });
        expect(response.headers['cache-control']).toBe('private, no-store');
      }
      const list = await call('GET', '');
      expect(list.json().items).toHaveLength(1);
      expect(list.json().items[0].event.title).toBe(event.title);
      expect(list.headers['cache-control']).toBe('private, no-store');
      const firstSavedAt = list.json().items[0].savedAt;
      await call('PUT', `/${event.id}`, a, { saved: true });
      expect((await call('GET', '')).json().items[0].savedAt).toBe(firstSavedAt);
      const fresh = new FirestoreSavedEventRepository(db);
      expect(await fresh.has(a.id, event.id)).toBe(true);
      expect((await fresh.list(a.id)).items).toHaveLength(1);
      expect((await call('GET', `/${event.id}`, b)).json()).toEqual({ saved: false });
      expect((await call('GET', '', b)).json().items).toEqual([]);
      expect(
        (await call('PUT', `/${event.id}`, a, { saved: false, userId: b.id })).statusCode,
      ).toBe(422);
      expect((await call('GET', `?userId=${b.id}`)).statusCode).toBe(422);
      await call('PUT', `/${event.id}`, b, { saved: true }, { 'x-user-id': a.id });
      await call('PUT', `/${event.id}`, b, { saved: false }, { 'x-user-id': a.id });
      expect(await fresh.has(a.id, event.id)).toBe(true);
      expect(await fresh.has(b.id, event.id)).toBe(false);
      await services.repos().events.save({
        ...event,
        version: 2,
        title: 'Changed canonical title',
        startAt: '2099-12-15T18:00:00Z',
      });
      expect((await call('GET', '')).json().items[0].event).toMatchObject({
        title: 'Changed canonical title',
        startAt: '2099-12-15T18:00:00Z',
      });
      await services
        .repos()
        .events.save({ ...event, version: 3, status: 'cancelled', isPublic: false });
      expect((await call('GET', '')).json().items[0].event).toBeNull();
      await services
        .repos()
        .events.save({ ...event, version: 4, visibilityMode: 'invited', isPublic: false });
      expect((await call('GET', '')).json().items[0].event).toBeNull();
      expect((await call('PUT', `/${event.id}`, a, { saved: true })).statusCode).toBe(404);
      for (const collection of [
        'v2_entitlements',
        'v2_orders',
        'v2_guest_social_privacy',
        'v2_guest_social_hidden_events',
      ])
        expect((await db.collection(collection).get()).size).toBe(0);
      await Promise.all(
        Array.from({ length: 4 }, () => call('PUT', `/${event.id}`, a, { saved: false })),
      );
      expect((await call('GET', '')).json().items).toEqual([]);
      expect(await fresh.has(a.id, event.id)).toBe(false);
      const pageIds = Array.from(
        { length: 23 },
        (_, index) => `page-${String(index).padStart(2, '0')}`,
      );
      await Promise.all(pageIds.map((id) => fresh.save(a.id, id, new Date().toISOString())));
      const first = await fresh.list(a.id);
      expect(first.items).toHaveLength(20);
      if (!first.nextCursor) throw new Error('Expected a second bookmark page');
      const second = await fresh.list(a.id, first.nextCursor);
      expect(second.items).toHaveLength(3);
      expect(new Set([...first.items, ...second.items].map((item) => item.eventId)).size).toBe(23);
      expect((await fresh.list(b.id)).items).toEqual([]);
      await Promise.all(pageIds.map((id) => fresh.remove(a.id, id)));
      await db.collection('v2_auth_users').doc(a.id).update({ emailVerified: false });
      expect((await call('GET', '')).statusCode).toBe(403);
    } finally {
      await fixture.close();
    }
  }, 60000);
});
