import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

import { createGuestProfileService } from '@c1rcle/core/application';
import { FirestoreGuestProfileRepository } from '@c1rcle/core/infrastructure/firestore';
import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';

import type { EmailSender } from '@c1rcle/core/domain';

import { getGatewayConfig } from '../../../config/index.js';
import { buildBetterAuth } from '../../../plugins/auth.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
describe.runIf(emulator)(
  'Google canonical identity (synthetic signed provider tokens, local Emulator)',
  () => {
    it('reuses linked identities and verified password users, rejects unverified local linking and duplicate password signup', async () => {
      if (!emulator || !/^(127\.0\.0\.1|localhost):\d+$/.test(emulator))
        throw new Error('Loopback Emulator required');
      vi.stubEnv('GOOGLE_CLIENT_ID', 'synthetic-google-client');
      vi.stubEnv('GOOGLE_CLIENT_SECRET', 'synthetic-google-secret');
      vi.stubEnv('GOOGLE_REDIRECT_URI', 'http://localhost:3000/api/auth/google/callback');
      const db = new Firestore({
        projectId: `demo-auth-${randomUUID().slice(0, 8)}`,
        host: emulator,
        ssl: false,
      });
      const auth = buildBetterAuth(
        getGatewayConfig({
          NODE_ENV: 'test',
          BETTER_AUTH_SECRET: 'synthetic-local-test-secret-at-least-32',
          BETTER_AUTH_URL: 'http://localhost:8080',
        }),
        db,
        { name: 'unused' } as EmailSender,
      );
      try {
        const context = await auth.$context;
        const candidate = context.socialProviders.find(
          (p) => typeof p !== 'function' && p.id === 'google',
        );
        if (
          !candidate ||
          typeof candidate === 'function' ||
          !candidate.idToken ||
          !('jwks' in candidate.idToken)
        )
          throw new Error('Google provider missing');
        const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
        candidate.idToken.jwks = async () => keys.publicKey;
        let lastToken = '';
        const google = async (email: string, sub: string, verified = true) => {
          const now = Math.floor(Date.now() / 1000);
          const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic' })).toString(
            'base64url',
          );
          const payload = Buffer.from(
            JSON.stringify({
              iss: 'https://accounts.google.com',
              aud: 'synthetic-google-client',
              sub,
              email,
              email_verified: verified,
              name: 'Synthetic',
              iat: now,
              exp: now + 600,
            }),
          ).toString('base64url');
          const input = `${header}.${payload}`;
          const token = `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
          lastToken = token;
          const result = await auth.api.signInSocial({
            body: { provider: 'google', idToken: { token } },
          });
          if (!('user' in result)) throw new Error('Expected native session');
          return result;
        };
        await expect(
          google('unverified@example.invalid', 'unverified-provider-id', false),
        ).rejects.toThrow();
        expect(
          (
            await db
              .collection('v2_auth_users')
              .where('email', '==', 'unverified@example.invalid')
              .get()
          ).size,
        ).toBe(0);
        const first = await google('new@example.invalid', 'new-provider-id');
        expect(first.user?.role).toBe('guest');
        const guestOnboarding = createGuestProfileService({
          guestProfiles: new FirestoreGuestProfileRepository(db),
          config: { clock: { now: () => new Date() } } as never,
        });
        expect((await guestOnboarding.getOnboarding(first.user.id)).complete).toBe(false);
        await guestOnboarding.saveOnboarding(first.user.id, {
          displayName: first.user.name,
          dateOfBirth: '2000-01-01',
        });
        await guestOnboarding.verifyPhone(first.user.id, '+919876543210', 'synthetic-proof', {
          name: 'fixture',
          verify: async () => ({ passed: true, provider: 'firebase-phone' }),
        });
        await guestOnboarding.saveOnboarding(first.user.id, { tastes: ['House'] });
        expect((await guestOnboarding.getOnboarding(first.user.id)).complete).toBe(true);

        // Exercise native authorization/state/callback and ordinary cookie session.
        candidate.validateAuthorizationCode = async () => ({ idToken: lastToken });
        const initiate = await auth.api.signInSocial({
          body: {
            provider: 'google',
            callbackURL: 'http://localhost:3000/profile',
            errorCallbackURL: 'http://localhost:3000/login?reason=google',
            disableRedirect: true,
          },
          asResponse: true,
        });
        const start = (await initiate.json()) as { url: string };
        const state = new URL(start.url).searchParams.get('state');
        expect(state).toBeTruthy();
        const stateCookies = initiate.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
        const completed = await auth.handler(
          new Request(
            `http://localhost:8080/api/v2/auth/callback/google?code=synthetic&state=${state}`,
            { headers: { cookie: stateCookies } },
          ),
        );
        expect(completed.status).toBe(302);
        expect(completed.headers.get('location')).toBe('http://localhost:3000/profile');
        const replay = await auth.handler(
          new Request(
            `http://localhost:8080/api/v2/auth/callback/google?code=synthetic&state=${state}`,
            { headers: { cookie: stateCookies } },
          ),
        );
        expect(replay.headers.get('location')).not.toBe('http://localhost:3000/profile');
        expect(
          replay.headers.getSetCookie().some((value) => value.includes('session_token=')),
        ).toBe(false);
        const expiring = await auth.api.signInSocial({
          body: {
            provider: 'google',
            callbackURL: 'http://localhost:3000/profile',
            disableRedirect: true,
          },
          asResponse: true,
        });
        const expiringUrl = new URL(((await expiring.json()) as { url: string }).url);
        const expiredCookies = expiring.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 11 * 60 * 1000);
        try {
          const expired = await auth.handler(
            new Request(
              `http://localhost:8080/api/v2/auth/callback/google?code=synthetic&state=${expiringUrl.searchParams.get('state')}`,
              { headers: { cookie: expiredCookies } },
            ),
          );
          expect(expired.headers.get('location')).not.toBe('http://localhost:3000/profile');
          expect(
            expired.headers.getSetCookie().some((value) => value.includes('session_token=')),
          ).toBe(false);
        } finally {
          vi.useRealTimers();
        }

        const sessionCookies = completed.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
        expect(
          (await auth.api.getSession({ headers: new Headers({ cookie: sessionCookies }) }))?.user
            .id,
        ).toBe(first.user?.id);
        await auth.api.signOut({ headers: new Headers({ cookie: sessionCookies }) });
        expect(
          await auth.api.getSession({ headers: new Headers({ cookie: sessionCookies }) }),
        ).toBeNull();
        const beforeCancel = (await db.collection('v2_auth_users').get()).size;
        const cancelled = await auth.handler(
          new Request(
            'http://localhost:8080/api/v2/auth/callback/google?error=access_denied&state=invalid',
          ),
        );
        expect(cancelled.status).toBe(302);
        expect((await db.collection('v2_auth_users').get()).size).toBe(beforeCancel);
        const failing = await auth.api.signInSocial({
          body: {
            provider: 'google',
            callbackURL: 'http://localhost:3000/profile',
            errorCallbackURL: 'http://localhost:3000/login?reason=google',
            disableRedirect: true,
          },
          asResponse: true,
        });
        const failingState = new URL(
          ((await failing.json()) as { url: string }).url,
        ).searchParams.get('state');
        const failingCookies = failing.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
        candidate.validateAuthorizationCode = async () => {
          throw new Error('synthetic provider unavailable');
        };
        const failed = await auth.handler(
          new Request(
            `http://localhost:8080/api/v2/auth/callback/google?code=synthetic&state=${failingState}`,
            { headers: { cookie: failingCookies } },
          ),
        );
        expect(failed.status).toBe(302);
        expect(failed.headers.get('location')).not.toBe('http://localhost:3000/profile');
        expect(
          failed.headers.getSetCookie().some((value) => value.includes('session_token=')),
        ).toBe(false);
        expect((await db.collection('v2_auth_users').get()).size).toBe(beforeCancel);

        expect((await google('new@example.invalid', 'new-provider-id')).user?.id).toBe(
          first.user?.id,
        );
        await expect(
          auth.api.signUpEmail({
            body: {
              email: 'new@example.invalid',
              password: 'Synthetic-password-16',
              name: 'Synthetic',
              role: 'guest',
            },
          }),
        ).rejects.toThrow();
        const local = await auth.api.signUpEmail({
          body: {
            email: 'local@example.invalid',
            password: 'Synthetic-password-16',
            name: 'Synthetic',
            role: 'guest',
          },
        });
        await expect(google('local@example.invalid', 'local-provider-id')).rejects.toThrow();
        await db.collection('v2_auth_users').doc(local.user.id).update({ emailVerified: true });
        expect((await google('local@example.invalid', 'local-provider-id')).user?.id).toBe(
          local.user.id,
        );
        expect(
          (await google('different@example.invalid', 'different-provider-id')).user?.id,
        ).not.toBe(local.user.id);
        expect(
          (await db.collection('v2_auth_users').where('email', '==', 'local@example.invalid').get())
            .size,
        ).toBe(1);
      } finally {
        await db.terminate();
        vi.unstubAllEnvs();
      }
    }, 60000);
  },
);
