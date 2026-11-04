import { randomUUID } from 'node:crypto';

import {
  MemoryStaffRotationStore,
  createOrganization,
  suspendOrganization,
  reinstateOrganization,
} from '@c1rcle/core/domain';
import {
  FirestoreOrganizationRepository,
  FirestoreUserBanRepository,
} from '@c1rcle/core/infrastructure/firestore';
import Fastify from 'fastify';
import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';

import type { OrganizationService } from '@c1rcle/core/application';
import type { EmailSender } from '@c1rcle/core/domain';

import { getGatewayConfig } from '../../../config/index.js';
import authContextPlugin, { buildBetterAuth } from '../../../plugins/auth.js';
import rateLimitPlugin from '../../../plugins/rate-limit.js';
import validateV2Plugin from '../../../plugins/validate-v2.js';

import authRoutes from './index.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)(
  'ban and suspension with native cookie/bearer sessions (local Emulator)',
  () => {
    it('enforces persisted changes, blocks new banned sessions, and preserves sign-out', async () => {
      if (!EMULATOR || !/^(127\.0\.0\.1|localhost):\d+$/.test(EMULATOR))
        throw new Error('Requires loopback Firestore Emulator');
      const db = new Firestore({ projectId: 'c1rcle-v2', host: EMULATOR, ssl: false });
      const app = Fastify({ logger: false });
      const id = `packet-1-6-${randomUUID()}`;
      let userId: string | undefined;
      const orgs = new FirestoreOrganizationRepository(db);
      const bans = new FirestoreUserBanRepository(db);
      const rotation = new MemoryStaffRotationStore();
      const sender = {
        name: 'unused',
        sendOtpEmail: async () => {},
        sendStaffInvitationEmail: async () => {},
        sendPasswordResetEmail: async () => {},
        sendOnboardingChangesRequestedEmail: async () => {},
      } as EmailSender;
      const auth = buildBetterAuth(
        getGatewayConfig({
          NODE_ENV: 'test',
          BETTER_AUTH_SECRET: 'local-emulator-access-test-secret-at-least-32',
          BETTER_AUTH_URL: 'http://localhost:8080',
        }),
        db,
        sender,
      );
      try {
        await app.register(validateV2Plugin);
        await app.register(rateLimitPlugin, { enabled: false });
        await app.register(authContextPlugin, {
          auth,
          organizations: orgs,
          rotationStore: rotation,
          userBans: bans,
        });
        await app.register(
          async (instance) =>
            authRoutes(instance, {
              auth,
              rotationStore: rotation,
              organizations: {} as OrganizationService,
            }),
          { prefix: '/api/v2/auth' },
        );
        app.get('/api/v2/protected', (request, reply) =>
          request.actor ? { userId: request.actor.userId } : reply.status(401).send({}),
        );
        const body = {
          email: `${id}@example.invalid`,
          password: 'Synthetic-password-at-least-16',
          displayName: 'Synthetic account',
        };
        const signup = await app.inject({
          method: 'POST',
          url: '/api/v2/auth/signup',
          payload: body,
        });
        expect(signup.statusCode).toBe(201);
        userId = signup.json().user.id as string;
        const bearer = { authorization: `Bearer ${signup.json().accessToken as string}` };
        const setCookies = signup.headers['set-cookie'];
        const cookie = (Array.isArray(setCookies) ? setCookies : [setCookies ?? ''])
          .map((value) => value.split(';')[0])
          .join('; ');
        expect(cookie).toContain('session_token');
        for (const headers of [bearer, { cookie }])
          expect((await app.inject({ url: '/api/v2/protected', headers })).statusCode).toBe(200);
        const org = createOrganization({
          id,
          name: 'Synthetic access org',
          slug: id,
          ownerId: userId,
        });
        await orgs.save(org);
        const scoped = { ...bearer, 'x-organization-id': id };
        expect((await app.inject({ url: '/api/v2/protected', headers: scoped })).statusCode).toBe(
          200,
        );
        const suspended = suspendOrganization(org);
        await orgs.save(suspended);
        for (const headers of [scoped, { cookie, 'x-organization-id': id }])
          expect((await app.inject({ url: '/api/v2/protected', headers })).statusCode).toBe(403);
        await orgs.save(reinstateOrganization(suspended));
        expect((await app.inject({ url: '/api/v2/protected', headers: scoped })).statusCode).toBe(
          200,
        );
        const now = new Date().toISOString();
        const ban = {
          id: userId,
          userId,
          isBanned: true,
          bannedAt: now,
          bannedBy: 'synthetic-admin',
          banReason: 'Synthetic test',
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        await bans.save(ban);
        for (const headers of [bearer, { cookie }]) {
          expect((await app.inject({ url: '/api/v2/protected', headers })).statusCode).toBe(403);
          expect((await app.inject({ url: '/api/v2/auth/session', headers })).statusCode).toBe(403);
          expect(
            (await app.inject({ method: 'POST', url: '/api/v2/auth/refresh', headers })).statusCode,
          ).toBe(403);
        }
        const sessions = () =>
          db.collection('v2_auth_sessions').where('userId', '==', userId).get();
        const before = (await sessions()).size;
        const login = await app.inject({
          method: 'POST',
          url: '/api/v2/auth/login',
          payload: { email: body.email, password: body.password },
        });
        expect(login.statusCode).toBeGreaterThanOrEqual(400);
        expect(login.json()).not.toHaveProperty('accessToken');
        expect(login.headers['set-cookie']).toBeUndefined();
        expect((await sessions()).size).toBe(before);
        const out = await app.inject({
          method: 'POST',
          url: '/api/v2/auth/logout',
          headers: { cookie, 'x-organization-id': id },
        });
        expect(out.statusCode).toBe(204);
        await bans.save({ ...ban, isBanned: false, version: 2 });
        expect((await app.inject({ url: '/api/v2/protected', headers: bearer })).statusCode).toBe(
          401,
        );
        const allowed = await app.inject({
          method: 'POST',
          url: '/api/v2/auth/login',
          payload: { email: body.email, password: body.password },
        });
        expect(allowed.statusCode).toBe(200);
        const beforeOutage = (await sessions()).size;
        const spy = vi
          .spyOn(FirestoreUserBanRepository.prototype, 'getByUserId')
          .mockRejectedValueOnce(new Error('Synthetic private storage failure'));
        try {
          const unavailable = await app.inject({
            method: 'POST',
            url: '/api/v2/auth/login',
            payload: { email: body.email, password: body.password },
          });
          expect(unavailable.statusCode).toBeGreaterThanOrEqual(500);
          expect(unavailable.body).not.toContain('private storage');
          expect(unavailable.json()).not.toHaveProperty('accessToken');
          expect(unavailable.headers['set-cookie']).toBeUndefined();
          expect((await sessions()).size).toBe(beforeOutage);
        } finally {
          spy.mockRestore();
        }
      } finally {
        await app.close();
        await db.collection('v2_organizations').doc(id).delete();
        userId ??= (
          await db.collection('v2_auth_users').where('email', '==', `${id}@example.invalid`).get()
        ).docs[0]?.id;
        if (userId) {
          for (const collection of ['v2_auth_sessions', 'v2_auth_accounts']) {
            const snapshot = await db.collection(collection).where('userId', '==', userId).get();
            await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
          }
          await db.collection('v2_auth_users').doc(userId).delete();
          await db.collection('v2_user_bans').doc(userId).delete();
        }
        await db.terminate();
      }
    }, 60_000);
  },
);
