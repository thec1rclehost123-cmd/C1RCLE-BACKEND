import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import rateLimitPlugin from '../../../plugins/rate-limit.js';
import validateV2Plugin from '../../../plugins/validate-v2.js';

import authRoutes from './index.js';

import type { BetterAuthInstance } from '../../../plugins/auth.js';
import type { FastifyInstance } from 'fastify';

/**
 * The auth routes only build a real Better Auth instance on
 * `STORAGE_DRIVER=firestore`, so these tests inject a fake `auth` whose
 * `api.signInEmail` / `api.signUpEmail` return the failure `Response` Better
 * Auth would. The point of interest is `forwardAuthErrorResponse`: on the
 * `login` path every 4xx must collapse to one constant body (no
 * account-existence oracle — spec §11.7 / D-024).
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeAuth(overrides: {
  signInEmail?: () => Promise<Response>;
  signUpEmail?: () => Promise<Response>;
}): BetterAuthInstance {
  return {
    api: {
      signInEmail: overrides.signInEmail ?? (() => Promise.resolve(jsonResponse(401, {}))),
      signUpEmail: overrides.signUpEmail ?? (() => Promise.resolve(jsonResponse(400, {}))),
    },
  } as unknown as BetterAuthInstance;
}

async function buildTestApp(auth: BetterAuthInstance): Promise<FastifyInstance> {
  // Fixed request id so two failure responses are byte-comparable.
  const app = Fastify({ genReqId: () => 'req_test', logger: false });
  await app.register(validateV2Plugin);
  await app.register(rateLimitPlugin, { enabled: false });
  await app.register(async (instance) => authRoutes(instance, { auth }), {
    prefix: '/api/v2/auth',
  });
  return app;
}

describe('auth routes — login failure is not an account-existence oracle', () => {
  it('returns a byte-identical body for an unknown email and a wrong password', async () => {
    const unknownEmailApp = await buildTestApp(
      fakeAuth({
        signInEmail: () => Promise.resolve(jsonResponse(401, { message: 'User not found' })),
      }),
    );
    const wrongPasswordApp = await buildTestApp(
      fakeAuth({
        signInEmail: () => Promise.resolve(jsonResponse(401, { message: 'Invalid password' })),
      }),
    );

    const unknownEmail = await unknownEmailApp.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { email: 'nobody@example.com', password: 'whatever1' },
    });
    const wrongPassword = await wrongPasswordApp.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { email: 'partner@example.com', password: 'wrongpass1' },
    });

    expect(unknownEmail.statusCode).toBe(400);
    expect(wrongPassword.statusCode).toBe(400);
    // The whole body, verbatim — message, code, status and requestId all match.
    expect(unknownEmail.body).toBe(wrongPassword.body);
    expect(unknownEmail.json().message).toBe('Authentication failed');
    expect(unknownEmail.json()).not.toHaveProperty('message', 'User not found');

    await unknownEmailApp.close();
    await wrongPasswordApp.close();
  });

  it('does not leak the provider message even when Better Auth returns a 400', async () => {
    const app = await buildTestApp(
      fakeAuth({
        signInEmail: () =>
          Promise.resolve(jsonResponse(400, { message: 'No account exists for this email' })),
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { email: 'nobody@example.com', password: 'whatever1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Authentication failed');
    await app.close();
  });

  it('still forwards the provider message on signup (the genericization is login-only)', async () => {
    const app = await buildTestApp(
      fakeAuth({
        signUpEmail: () =>
          Promise.resolve(jsonResponse(400, { message: 'Email already registered' })),
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/signup',
      payload: { email: 'taken@example.com', password: 'longenough1', displayName: 'Taken' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Email already registered');
    await app.close();
  });
});
