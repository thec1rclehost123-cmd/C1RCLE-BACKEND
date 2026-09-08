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
    // Same generic message for "never sent" as for "wrong code" below — the
    // route must not let an attacker distinguish the two (that would be an
    // oracle for whether a signup is pending for an arbitrary address).
    expect(res.json().message).toBe('Invalid or expired code.');
  });

  it('gives the identical error for a wrong code as for no-send-in-progress (no oracle)', async () => {
    const server = await buildServer();
    await server.inject({
      method: 'POST',
      url: '/otp/send',
      payload: { email: 'wrongcode@example.com' },
    });
    // '000000' is astronomically unlikely to be the real code, but never
    // assert against randomness — try both fixed candidates.
    const first = await server.inject({
      method: 'POST',
      url: '/otp/verify',
      payload: { email: 'wrongcode@example.com', code: '000000' },
    });
    const res =
      first.statusCode === 400
        ? first
        : await server.inject({
            method: 'POST',
            url: '/otp/verify',
            payload: { email: 'wrongcode@example.com', code: '111111' },
          });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Invalid or expired code.');
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
