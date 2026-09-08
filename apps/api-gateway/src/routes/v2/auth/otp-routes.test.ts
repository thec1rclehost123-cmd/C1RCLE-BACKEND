import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import otpRoutes from './otp-routes.js';

/**
 * ─── Email OTP routes ────────────────────────────────────────────────────────
 * No `X-Organization-Id`/actor needed — pre-session, like `/auth/signup`.
 * The gateway's dev-mode `ResendEmailSender` isn't wired here (no
 * `RESEND_API_KEY` under the memory test driver), but that's exactly why the
 * domain-level `EmailOtpService` test suite reads the code back off the
 * sender directly — these route tests instead exercise the HTTP contract
 * (status codes, generic ack, validation) rather than the code round-trip.
 */
const buildServer = () => buildPartnerTestServer({ routes: [otpRoutes] });

describe('POST /auth/otp/send', () => {
  it('acknowledges a well-formed request', async () => {
    const server = await buildServer();
    const res = await server.inject({
      method: 'POST',
      url: '/otp/send',
      payload: { email: 'partner@example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'If valid, a code has been sent.' });
  });

  it('acknowledges a resend within the cooldown with the same generic ack (no oracle)', async () => {
    const server = await buildServer();
    const first = await server.inject({
      method: 'POST',
      url: '/otp/send',
      payload: { email: 'cooldown@example.com' },
    });
    const second = await server.inject({
      method: 'POST',
      url: '/otp/send',
      payload: { email: 'cooldown@example.com' },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it('rejects a malformed email', async () => {
    const server = await buildServer();
    const res = await server.inject({
      method: 'POST',
      url: '/otp/send',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('POST /auth/otp/verify', () => {
  it('rejects a code with no send in progress', async () => {
    const server = await buildServer();
    const res = await server.inject({
      method: 'POST',
      url: '/otp/verify',
      payload: { email: 'nobody@example.com', code: '123456' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed code shape', async () => {
    const server = await buildServer();
    const res = await server.inject({
      method: 'POST',
      url: '/otp/verify',
      payload: { email: 'partner@example.com', code: 'abc' },
    });
    expect(res.statusCode).toBe(422);
  });
});
