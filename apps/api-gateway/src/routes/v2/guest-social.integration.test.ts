import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { createEvent, createOrganization } from '@c1rcle/core/domain';
import { FirestoreGuestSocialRepository } from '@c1rcle/core/guest-social';
import { Firestore } from 'firebase-admin/firestore';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Native auth + real Firestore, restricted to disposable loopback demo data. */
async function createSocialFixture() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
    throw new Error('Loopback Firestore Emulator required');
  const projectId = `demo-c1rcle-social-${randomUUID().slice(0, 8)}`;
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const overrides = {
    NODE_ENV: 'test',
    STORAGE_DRIVER: 'firestore',
    BACKGROUND_WORKERS_ENABLED: 'false',
    M5_TICKET_TRANSFERS_ENABLED: 'true',
    M5_OFFLINE_TICKET_MANIFESTS_ENABLED: 'false',
    M5_OFFLINE_MANIFEST_DRAIN_COMPLETE: 'true',
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
describe.runIf(emulator)('Guest social native auth and Firestore privacy', () => {
  it('enforces audience, consent, holder state, cross-user isolation, withdrawal, blocks and private reports', async () => {
    const fixture = await createSocialFixture();
    const { app, services, accounts, db } = fixture;
    const [a, b, partner] = accounts;
    if (!a || !b || !partner) throw new Error('Missing synthetic accounts');
    const consent = { profileVisible: true, showOnGuestlists: true, showUpcomingEvents: true };
    const call = (
      method: 'GET' | 'PUT' | 'POST' | 'PATCH',
      path: string,
      actor = a,
      payload?: Record<string, unknown>,
      headers = {},
    ) =>
      app.inject({
        method,
        url: `/api/v2/${path}`,
        headers: { ...actor.headers, ...headers },
        ...(payload === undefined ? {} : { payload }),
      });
    try {
      const org = createOrganization({
        id: 'social-native-org',
        ownerId: partner.id,
        name: 'Synthetic social host',
        slug: 'social-native-host',
        capabilities: ['host'],
      });
      await services.repos().organizations.save(org);
      const event = {
        ...createEvent({
          id: 'social-native-event',
          organizationId: org.id,
          venueId: 'synthetic-venue',
          title: 'Synthetic Social Night',
          startAt: '2099-12-01T18:00:00Z',
          endAt: '2099-12-02T01:00:00Z',
        }),
        status: 'published' as const,
        isPublic: true,
      };
      await services.repos().events.save(event);
      const ticket = {
        id: 'social-native-ticket',
        eventId: event.id,
        organizationId: org.id,
        orderId: 'private-order',
        tierId: 'private-tier',
        tierName: 'General',
        userId: a.id,
        currentHolderUserId: b.id,
        holderName: 'Private door name',
        status: 'valid' as const,
        scanCountAllowed: 2,
        scanCount: 0,
        scannedAt: [],
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await services.repos().entitlements.save(ticket);
      const storedTicket = await services.repos().entitlements.getById(ticket.id);
      const storedEvent = await services.repos().events.getById(event.id);
      const endpoint = `social/profiles/${b.id}`;
      expect((await app.inject({ method: 'GET', url: `/api/v2/${endpoint}` })).statusCode).toBe(
        401,
      );
      expect((await call('GET', endpoint, partner)).statusCode).toBe(403);
      expect((await call('GET', endpoint)).statusCode).toBe(404);
      expect((await call('PUT', 'social/privacy', b, consent)).statusCode).toBe(200);
      expect(
        (await call('PUT', 'social/privacy', a, { ...consent, userId: b.id })).statusCode,
      ).toBe(422);
      const read = await call('GET', endpoint, a, undefined, { 'x-user-id': b.id });
      expect(read.statusCode).toBe(200);
      expect(read.headers['cache-control']).toBe('private, no-store');
      expect(Object.keys(read.json().identity).sort()).toEqual(
        ['id', 'displayName', 'avatarUrl', 'interests'].sort(),
      );
      for (const secret of [
        b.email,
        '+919000000042',
        '2000-01-01',
        'private-order',
        'private-tier',
        ticket.id,
      ])
        expect(read.body).not.toContain(secret);
      expect(read.json().upcomingEvents).toEqual([]);
      const policy = `organizations/${org.id}/social-events/${event.id}`;
      const orgHeaders = { 'x-organization-id': org.id };
      expect((await call('PATCH', policy, a, { enabled: true }, orgHeaders)).statusCode).toBe(403);
      const enabled = await call('PATCH', policy, partner, { enabled: true }, orgHeaders);
      expect(enabled.statusCode, enabled.body).toBe(200);
      const publicPolicy = await app.inject({
        method: 'GET',
        url: `/api/v2/public/events/${event.id}/social-policy`,
      });
      expect(publicPolicy.json()).toEqual({ enabled: true });
      const listPath = `social/events/${event.id}/guestlist`;
      expect((await app.inject({ method: 'GET', url: `/api/v2/${listPath}` })).statusCode).toBe(
        401,
      );
      expect((await call('GET', listPath)).json()).toMatchObject({
        visibleCount: 1,
        items: [{ id: b.id }],
      });
      expect((await call('GET', endpoint)).json().upcomingEvents).toHaveLength(1);
      const fresh = new FirestoreGuestSocialRepository(db);
      expect(await fresh.getPrivacy(b.id)).toEqual(consent);
      expect(await fresh.eventEnabled(event.id)).toBe(true);
      expect(
        (await call('PUT', `social/events/${event.id}/visibility`, b, { hidden: true })).statusCode,
      ).toBe(200);
      expect(await fresh.eventHidden(b.id, event.id)).toBe(true);
      expect((await call('GET', endpoint)).json().upcomingEvents).toEqual([]);
      expect((await call('GET', listPath)).json().visibleCount).toBe(0);
      await call('PUT', `social/events/${event.id}/visibility`, b, { hidden: false });
      await call('PUT', 'social/privacy', b, { ...consent, profileVisible: false });
      expect((await call('GET', endpoint)).statusCode).toBe(404);
      expect((await call('GET', listPath)).json().visibleCount).toBe(0);
      await call('PUT', 'social/privacy', b, consent);
      await call('PUT', `social/blocks/${b.id}`, a, { blocked: true });
      expect(await fresh.blockedEitherWay(a.id, b.id)).toBe(true);
      expect((await call('GET', endpoint)).statusCode).toBe(404);
      await call('PUT', 'social/privacy', a, consent);
      expect((await call('GET', `social/profiles/${a.id}`, b)).statusCode).toBe(404);
      await call('PUT', `social/blocks/${b.id}`, a, { blocked: false });
      expect((await call('GET', endpoint)).statusCode).toBe(200);
      const reportBody = { category: 'safety', reason: 'Synthetic social privacy report reason.' };
      const reportPath = `social/reports/${b.id}`;
      const reportHeaders = { 'idempotency-key': 'social-native-report-key' };
      const report = await call('POST', reportPath, a, reportBody, reportHeaders);
      expect(report.statusCode, report.body).toBe(201);
      expect((await call('POST', reportPath, a, reportBody, reportHeaders)).json()).toEqual(
        report.json(),
      );
      const saved = await services.repos().supportTickets.getById(report.json().reference);
      expect(saved).toMatchObject({
        requester: { userId: a.id, email: null },
        links: { userId: b.id },
      });
      expect(await services.repos().userBans.getByUserId(b.id)).toBeNull();
      expect(await services.repos().entitlements.getById(ticket.id)).toEqual(storedTicket);
      expect(await services.repos().events.getById(event.id)).toEqual(storedEvent);
      // Exercise the unchanged native transfer command and accepted-holder projection.
      const requested = await call('POST', `tickets/${ticket.id}/transfers`, b, {
        recipientEmail: a.email,
      });
      expect(requested.statusCode, requested.body).toBe(201);
      expect((await call('GET', endpoint)).json().upcomingEvents).toHaveLength(1);
      const accepted = await call('POST', `ticket-transfers/${requested.json().id}/accept`, a);
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect((await call('GET', endpoint)).json().upcomingEvents).toEqual([]);
      expect((await call('GET', `social/profiles/${a.id}`, b)).json().upcomingEvents).toHaveLength(
        1,
      );
      expect((await call('GET', listPath)).json()).toMatchObject({
        visibleCount: 1,
        items: [{ id: a.id }],
      });
      // An explicit unclaimed holder must not fall back to the purchaser.
      await services.repos().entitlements.save({
        ...accepted.json().entitlement,
        version: accepted.json<{ entitlement: { version: number } }>().entitlement.version + 1,
        currentHolderUserId: null,
      });
      expect((await call('GET', listPath)).json().visibleCount).toBe(0);
      expect((await call('GET', endpoint)).json().upcomingEvents).toEqual([]);
      await db.collection('v2_auth_users').doc(a.id).update({ emailVerified: false });
      expect((await call('GET', endpoint)).statusCode).toBe(403);
      expect((await call('POST', reportPath, a, reportBody, reportHeaders)).statusCode).toBe(403);
    } finally {
      await fixture.close();
    }
  }, 60000);
});
