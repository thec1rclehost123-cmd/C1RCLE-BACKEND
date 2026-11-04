import { randomUUID } from 'node:crypto';

import { createEmailOtpService } from '@c1rcle/core/application';
import { MemoryStaffRotationStore } from '@c1rcle/core/domain';
import {
  FirestoreEmailOtpRepository,
  FirestoreOrganizationRepository,
  FirestoreUserAccountRepository,
} from '@c1rcle/core/infrastructure/firestore';
import Fastify from 'fastify';
import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import type { OrganizationService, ServiceDeps } from '@c1rcle/core/application';
import type { EmailSender } from '@c1rcle/core/domain';

import { getGatewayConfig } from '../../../config/index.js';
import { buildBetterAuth } from '../../../plugins/auth.js';
import rateLimitPlugin from '../../../plugins/rate-limit.js';
import validateV2Plugin from '../../../plugins/validate-v2.js';

import otpRoutes from './otp-routes.js';

import authRoutes from './index.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('OTP account verification and existing sessions (local emulator)', () => {
  it('persists verification, exposes it after reload, and leaves other accounts unverified', async () => {
    if (!EMULATOR || !/^(127\.0\.0\.1|localhost):\d+$/.test(EMULATOR)) {
      throw new Error('Account verification tests require a loopback Firestore emulator');
    }
    const db = new Firestore({ projectId: 'c1rcle-v2', host: EMULATOR, ssl: false });
    const app = Fastify({ logger: false });
    const users = new FirestoreUserAccountRepository(db);
    const otp = new FirestoreEmailOtpRepository(db);
    const codes = new Map<string, string>();
    const accountIds: string[] = [];
    const emails = [
      `packet-1-3-${randomUUID()}@example.invalid`,
      `packet-1-3-other-${randomUUID()}@example.invalid`,
      `packet-1-4-partner-${randomUUID()}@example.invalid`,
    ];
    const email = emails[0];
    const otherEmail = emails[1];
    if (!email || !otherEmail) throw new Error('Expected synthetic email addresses');
    const sender: EmailSender = {
      name: 'local-test-capture',
      sendOtpEmail: async (recipient, code) => {
        codes.set(recipient, code);
      },
      sendStaffInvitationEmail: async () => {},
      sendPasswordResetEmail: async () => {},
      sendOnboardingChangesRequestedEmail: async () => {},
    };
    const config = getGatewayConfig({
      NODE_ENV: 'test',
      BETTER_AUTH_SECRET: 'local-emulator-test-secret-at-least-32-chars',
      BETTER_AUTH_URL: 'http://localhost:8080',
    });
    const auth = buildBetterAuth(config, db, sender);
    const service = createEmailOtpService({
      emailOtp: otp,
      users,
      emailSender: sender,
      config: {
        clock: { now: () => new Date() },
        emailOtpSecret: 'local-test-otp-secret',
      } as ServiceDeps['config'],
    });
    try {
      await app.register(validateV2Plugin);
      await app.register(rateLimitPlugin, { enabled: false });
      await app.register(
        async (instance) => {
          await authRoutes(instance, {
            auth,
            rotationStore: new MemoryStaffRotationStore(),
            organizations: {} as OrganizationService,
          });
          await otpRoutes(instance, { emailOtp: service });
        },
        { prefix: '/api/v2/auth' },
      );
      const password = 'local-test-password-at-least-16-chars';
      for (const [index, recipient] of emails.entries()) {
        const path = index === 2 ? '/partner/signup' : '/signup';
        const role = index === 2 ? 'partner' : 'guest';
        const signup = await app.inject({
          method: 'POST',
          url: `/api/v2/auth${path}`,
          payload: { email: recipient, password, displayName: 'Synthetic account' },
        });
        expect(signup.statusCode).toBe(201);
        const created = signup.json<{ user: { id: string; role: string }; accessToken: string }>();
        accountIds.push(created.user.id);
        expect(created.user.role).toBe(role);
        expect(await users.getById(created.user.id)).toMatchObject({ email: recipient, role });
        const session = await app.inject({
          method: 'GET',
          url: '/api/v2/auth/session',
          headers: { authorization: `Bearer ${created.accessToken}` },
        });
        expect(session.statusCode).toBe(200);
        expect(session.json().user.role).toBe(role);
        expect(
          (
            await new FirestoreOrganizationRepository(db).listForMember(created.user.id, {
              limit: 10,
            })
          ).items,
        ).toHaveLength(0);
      }
      for (const path of ['/signup', '/partner/signup']) {
        const rejected = await app.inject({
          method: 'POST',
          url: `/api/v2/auth${path}`,
          payload: { email, password, displayName: 'Forged role', role: 'admin' },
        });
        expect(rejected.statusCode).toBe(422);
      }
      const login = await auth.api.signInEmail({ body: { email, password } });
      const headers = { authorization: `Bearer ${login.token}` };
      const cookieLogin = await auth.api.signInEmail({
        body: { email, password },
        asResponse: true,
      });
      const cookie = cookieLogin.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      expect(cookie).not.toBe('');
      const before = await app.inject({ method: 'GET', url: '/api/v2/auth/session', headers });
      expect(before.statusCode).toBe(200);
      expect(before.json().user.emailVerified).toBe(false);
      const sent = await app.inject({
        method: 'POST',
        url: '/api/v2/auth/otp/send',
        payload: { email },
      });
      expect(sent.statusCode).toBe(200);
      const code = codes.get(email);
      if (!code) throw new Error('Expected captured OTP');
      const forgedTarget = await app.inject({
        method: 'POST',
        url: '/api/v2/auth/otp/verify',
        payload: { email, code, userId: accountIds[1], emailVerified: true },
      });
      expect(forgedTarget.statusCode).toBe(422);
      expect(await users.getByEmail(otherEmail)).toMatchObject({ emailVerified: false });
      expect(await otp.get(email)).not.toBeNull();
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/v2/auth/otp/verify',
        payload: { email, code: code === '000000' ? '111111' : '000000' },
      });
      expect(wrong.statusCode).toBe(400);
      expect(await users.getByEmail(email)).toMatchObject({ emailVerified: false });
      const verified = await app.inject({
        method: 'POST',
        url: '/api/v2/auth/otp/verify',
        payload: { email, code },
      });
      expect(verified.statusCode).toBe(200);
      expect(await users.getByEmail(email)).toMatchObject({
        id: login.user.id,
        emailVerified: true,
      });
      expect(await users.getByEmail(otherEmail)).toMatchObject({ emailVerified: false });
      expect(await otp.get(email)).toBeNull();
      for (const sessionHeaders of [headers, { cookie }]) {
        const session = await app.inject({
          method: 'GET',
          url: '/api/v2/auth/session',
          headers: sessionHeaders,
        });
        expect(session.statusCode).toBe(200);
        expect(session.json().user.emailVerified).toBe(true);
        const refreshed = await app.inject({
          method: 'POST',
          url: '/api/v2/auth/refresh',
          headers: sessionHeaders,
        });
        expect(refreshed.statusCode).toBe(200);
        expect(refreshed.json().user.emailVerified).toBe(true);
      }
      const reloadedAuth = buildBetterAuth(config, db, sender);
      expect(
        (await reloadedAuth.api.getSession({ headers: new Headers(headers) }))?.user.emailVerified,
      ).toBe(true);
      const replay = await app.inject({
        method: 'POST',
        url: '/api/v2/auth/otp/verify',
        payload: { email, code },
      });
      expect(replay.statusCode).toBe(400);
    } finally {
      await app.close();
      for (const userId of accountIds) {
        for (const collection of ['v2_auth_sessions', 'v2_auth_accounts']) {
          const docs = await db.collection(collection).where('userId', '==', userId).get();
          await Promise.all(docs.docs.map((doc) => doc.ref.delete()));
        }
        await db.collection('v2_auth_users').doc(userId).delete();
      }
      await Promise.all(
        emails.map((recipient) => db.collection('v2_email_otps').doc(recipient).delete()),
      );
      await db.terminate();
    }
  }, 60_000);
});
