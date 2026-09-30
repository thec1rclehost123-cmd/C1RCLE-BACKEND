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
  requestPasswordReset?: () => Promise<{ status: true; message: string }>;
  resetPassword?: () => Promise<{ status: true }>;
}): BetterAuthInstance {
  return {
    api: {
      signInEmail: overrides.signInEmail ?? (() => Promise.resolve(jsonResponse(401, {}))),
      signUpEmail: overrides.signUpEmail ?? (() => Promise.resolve(jsonResponse(400, {}))),
      requestPasswordReset:
        overrides.requestPasswordReset ??
        (() => Promise.resolve({ status: true, message: 'If this email exists in our system' })),
      resetPassword: overrides.resetPassword ?? (() => Promise.resolve({ status: true })),
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

    // Better Auth answers a bad credential with 401; the gateway forwards that
    // status rather than collapsing it to 400, so a client can tell "wrong
    // password" from "malformed payload". The anti-oracle guarantee is carried
    // by the message/code, not by the status — see the next assertions.
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.json().code).toBe('unauthorized');
    expect(wrongPassword.json().code).toBe('unauthorized');
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

describe('auth routes — password reset', () => {
  it('POST /forgot-password returns the constant ack (no account-existence oracle)', async () => {
    let receivedEmail: string | undefined;
    const app = await buildTestApp(
      fakeAuth({
        requestPasswordReset: () => {
          receivedEmail = 'partner@example.com';
          return Promise.resolve({ status: true, message: 'If this email exists in our system' });
        },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/forgot-password',
      payload: { email: 'partner@example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: true,
      message: 'If this email exists in our system',
    });
    expect(receivedEmail).toBe('partner@example.com');
    await app.close();
  });

  it('POST /forgot-password forwards a thrown Better Auth error (e.g. RESET_PASSWORD_DISABLED)', async () => {
    const app = await buildTestApp(
      fakeAuth({
        requestPasswordReset: () =>
          Promise.reject(
            Object.assign(new Error('Reset password is not enabled'), { status: 400 }),
          ),
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/forgot-password',
      payload: { email: 'nobody@example.com' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Reset password is not enabled');
    await app.close();
  });

  it('POST /reset-password returns { status: true } on success', async () => {
    const app = await buildTestApp(
      fakeAuth({
        resetPassword: () => Promise.resolve({ status: true }),
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/reset-password',
      payload: { newPassword: 'newsecret1', token: 'tok123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: true });
    await app.close();
  });

  it('POST /reset-password forwards a thrown Better Auth INVALID_TOKEN error', async () => {
    const app = await buildTestApp(
      fakeAuth({
        resetPassword: () =>
          Promise.reject(Object.assign(new Error('INVALID_TOKEN'), { status: 400 })),
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/reset-password',
      payload: { newPassword: 'newsecret1', token: 'expired' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('INVALID_TOKEN');
    await app.close();
  });

  it('rejects malformed payloads with 422 (min password length enforced by schema)', async () => {
    const app = await buildTestApp(fakeAuth({}));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/reset-password',
      payload: { newPassword: 'short', token: 'tok123' },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});
