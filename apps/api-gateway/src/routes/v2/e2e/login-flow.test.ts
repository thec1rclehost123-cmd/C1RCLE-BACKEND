import { createPlatformAdmin } from '@c1rcle/core/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../../app.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import authRoutes from '../auth/index.js';
import otpRoutes from '../auth/otp-routes.js';

import type { BetterAuthInstance } from '../../../plugins/auth.js';
import type { FastifyInstance } from 'fastify';

/**
 * ─── Login-flow suite ────────────────────────────────────────────────────────
 * Better Auth only exists on the firestore driver, so the credential/session
 * routes are exercised against a STATEFUL in-memory stand-in for
 * `auth.api.*` behind the REAL route stack (validate-v2, rate-limit, response
 * validation). Email OTP uses the real service + memory repo (the sent code is
 * captured off the sender). Role gating runs against the full `buildApp()`.
 */

const services = createV2Services();

const USER = {
  id: 'usr_1',
  email: 'partner@example.com',
  name: 'Partner One',
  image: '',
  password: 'correct-horse-1',
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function statefulAuth() {
  const sessions = new Map<string, { userId: string; expiresAt: Date }>();
  const resetTokens = new Map<string, string>();
  let password = USER.password;
  const tokenFrom = (headers: Headers): string | undefined => {
    const bearer = headers.get('authorization')?.replace(/^Bearer /, '');
    if (bearer) return bearer;
    return /better-auth\.session_token=([^;]+)/.exec(headers.get('cookie') ?? '')?.[1];
  };
  const api = {
    signInEmail: ({ body }: { body: { email: string; password: string } }) => {
      if (body.email !== USER.email || body.password !== password) {
        return Promise.resolve(json(401, { message: 'Invalid email or password' }));
      }
      const token = `tok_${sessions.size + 1}`;
      sessions.set(token, { userId: USER.id, expiresAt: new Date(Date.now() + 7 * 864e5) });
      return Promise.resolve(
        json(
          200,
          {},
          {
            'set-cookie': `better-auth.session_token=${token}; Path=/; HttpOnly; SameSite=Lax`,
            'set-auth-token': token,
          },
        ),
      );
    },
    signUpEmail: () => Promise.resolve(json(400, {})),
    getSession: ({ headers }: { headers: Headers }) => {
      const token = tokenFrom(headers);
      const session = token ? sessions.get(token) : undefined;
      if (!token || !session) return Promise.resolve(null);
      return Promise.resolve({
        user: { id: USER.id, email: USER.email, name: USER.name, image: USER.image },
        session: { token, expiresAt: session.expiresAt },
      });
    },
    signOut: ({ headers }: { headers: Headers }) => {
      const token = tokenFrom(headers);
      if (token) sessions.delete(token);
      return Promise.resolve(
        json(
          200,
          { success: true },
          { 'set-cookie': 'better-auth.session_token=; Path=/; Max-Age=0; HttpOnly' },
        ),
      );
    },
    // Better Auth's own anti-oracle: identical ack for known and unknown emails.
    requestPasswordReset: ({ body }: { body: { email: string } }) => {
      if (body.email === USER.email) resetTokens.set('reset-tok', USER.id);
      return Promise.resolve({ status: true, message: 'If this email exists in our system' });
    },
    resetPassword: ({ body }: { body: { newPassword: string; token: string } }) => {
      if (!resetTokens.has(body.token)) {
        return Promise.reject(Object.assign(new Error('Invalid token'), { status: 400 }));
      }
      resetTokens.delete(body.token);
      password = body.newPassword;
      return Promise.resolve({ status: true });
    },
  };
  return { auth: { api } as unknown as BetterAuthInstance, sessions };
}

const open: FastifyInstance[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function authServer(rateLimit = false) {
  const { auth, sessions } = statefulAuth();
  const server = await buildPartnerTestServer({
    rateLimit,
    routes: [async (f) => authRoutes(f, { auth }), otpRoutes],
  });
  open.push(server);
  return { server, sessions };
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first).split(';')[0] ?? '';
}

describe('password sign-in -> session -> refresh -> logout', () => {
  it('returns {user, accessToken, expiresAt} plus an httpOnly session cookie', async () => {
    const { server } = await authServer();
    const res = await server.inject({
      method: 'POST',
      url: '/login',
      payload: { email: USER.email, password: USER.password },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.user).toMatchObject({ id: USER.id, email: USER.email, avatarUrl: null });
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly/i);
    // Wire shape: no role escalation fields beyond the contract.
    expect(Object.keys(body).sort()).toEqual(['accessToken', 'expiresAt', 'user']);
  });

  it('GET /session works by cookie and by bearer token, 401 without either', async () => {
    const { server } = await authServer();
    const login = await server.inject({
      method: 'POST',
      url: '/login',
      payload: { email: USER.email, password: USER.password },
    });
    const byCookie = await server.inject({
      method: 'GET',
      url: '/session',
      headers: { cookie: cookieOf(login) },
    });
    expect(byCookie.statusCode, byCookie.body).toBe(200);
    expect(byCookie.json().user.email).toBe(USER.email);
    expect(Object.keys(byCookie.json()).sort()).toEqual(['expiresAt', 'user']);

    const byBearer = await server.inject({
      method: 'GET',
      url: '/session',
      headers: { authorization: `Bearer ${login.json().accessToken}` },
    });
    expect(byBearer.statusCode).toBe(200);

    const anon = await server.inject({ method: 'GET', url: '/session' });
    expect(anon.statusCode).toBe(401);
    expect(anon.json().code).toBe('unauthorized');
  });

  it('refresh re-validates the session; logout clears it and the session is gone', async () => {
    const { server, sessions } = await authServer();
    const login = await server.inject({
      method: 'POST',
      url: '/login',
      payload: { email: USER.email, password: USER.password },
    });
    const cookie = cookieOf(login);

    const refreshed = await server.inject({
      method: 'POST',
      url: '/refresh',
      headers: { cookie },
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json().accessToken).toBe(login.json().accessToken);

    const out = await server.inject({ method: 'POST', url: '/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/i);
    expect(sessions.size).toBe(0);

    expect(
      (await server.inject({ method: 'GET', url: '/session', headers: { cookie } })).statusCode,
    ).toBe(401);
    expect(
      (await server.inject({ method: 'POST', url: '/refresh', headers: { cookie } })).statusCode,
    ).toBe(401);
  });

  it('wrong password and unknown email are indistinguishable', async () => {
    const { server } = await authServer();
    const wrong = await server.inject({
      method: 'POST',
      url: '/login',
      payload: { email: USER.email, password: 'wrong-password-1' },
    });
    const unknown = await server.inject({
      method: 'POST',
      url: '/login',
      payload: { email: 'nobody@example.com', password: 'wrong-password-1' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().message).toBe('Authentication failed');
    expect(unknown.json().message).toBe(wrong.json().message);
    expect(wrong.json().code).toBe(unknown.json().code);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('throttles credential stuffing on login (SENSITIVE_COMMAND)', async () => {
    const { server } = await authServer(true);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await server.inject({
        method: 'POST',
        url: '/login',
        payload: { email: USER.email, password: `wrong-password-${i}` },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses).toContain(429);
  });
});

describe('password reset', () => {
  it('forgot-password acks identically for known and unknown emails', async () => {
    const { server } = await authServer();
    const known = await server.inject({
      method: 'POST',
      url: '/forgot-password',
      payload: { email: USER.email },
    });
    const unknown = await server.inject({
      method: 'POST',
      url: '/forgot-password',
      payload: { email: 'ghost@example.com' },
    });
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(known.json()).toEqual(unknown.json());
  });

  it('reset-password rotates the credential: old password dies, new one works, token is single-use', async () => {
    const { server } = await authServer();
    await server.inject({
      method: 'POST',
      url: '/forgot-password',
      payload: { email: USER.email },
    });
    const reset = await server.inject({
      method: 'POST',
      url: '/reset-password',
      payload: { token: 'reset-tok', newPassword: 'brand-new-pass-9' },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json()).toEqual({ status: true });

    const old = await server.inject({
      method: 'POST',
      url: '/login',
      payload: { email: USER.email, password: USER.password },
    });
    expect(old.statusCode).toBe(401);
    const fresh = await server.inject({
      method: 'POST',
      url: '/login',
      payload: { email: USER.email, password: 'brand-new-pass-9' },
    });
    expect(fresh.statusCode).toBe(200);

    const replay = await server.inject({
      method: 'POST',
      url: '/reset-password',
      payload: { token: 'reset-tok', newPassword: 'another-pass-10' },
    });
    expect(replay.statusCode).toBe(400);
  });

  it('rejects a too-short new password at the schema boundary', async () => {
    const { server } = await authServer();
    const res = await server.inject({
      method: 'POST',
      url: '/reset-password',
      payload: { token: 'reset-tok', newPassword: 'short' },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('email OTP (real service, memory repo)', () => {
  function captureCodes(): string[] {
    const codes: string[] = [];
    vi.spyOn(services.emailSender, 'sendOtpEmail').mockImplementation((_to, code) => {
      codes.push(code);
      return Promise.resolve();
    });
    return codes;
  }

  it('send -> verify round-trip with the emailed code; ack is generic', async () => {
    const codes = captureCodes();
    const { server } = await authServer();
    const send = await server.inject({
      method: 'POST',
      url: '/otp/send',
      payload: { email: 'otp-ok@example.com' },
    });
    expect(send.statusCode).toBe(200);
    expect(send.json()).toEqual({ message: 'If valid, a code has been sent.' });
    expect(codes).toHaveLength(1);

    const wrong = await server.inject({
      method: 'POST',
      url: '/otp/verify',
      payload: { email: 'otp-ok@example.com', code: codes[0] === '000000' ? '111111' : '000000' },
    });
    expect(wrong.statusCode).toBe(400);

    const ok = await server.inject({
      method: 'POST',
      url: '/otp/verify',
      payload: { email: 'otp-ok@example.com', code: codes[0] },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ message: 'Verified.' });
  });

  it('does not enumerate: unverified/unknown address fails the same way as a wrong code', async () => {
    const codes = captureCodes();
    const { server } = await authServer();
    await server.inject({
      method: 'POST',
      url: '/otp/send',
      payload: { email: 'otp-known@example.com' },
    });
    const wrongCode = await server.inject({
      method: 'POST',
      url: '/otp/verify',
      payload: {
        email: 'otp-known@example.com',
        code: codes[0] === '000000' ? '111111' : '000000',
      },
    });
    const neverSent = await server.inject({
      method: 'POST',
      url: '/otp/verify',
      payload: { email: 'otp-never@example.com', code: '123456' },
    });
    expect(neverSent.statusCode).toBe(wrongCode.statusCode);
    expect(neverSent.json().message).toBe(wrongCode.json().message);
    expect(neverSent.json().code).toBe(wrongCode.json().code);
  });

  it('rate-limits OTP verify (OTP_VERIFY: 10/min) with 429', async () => {
    captureCodes();
    const { server } = await authServer(true);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await server.inject({
        method: 'POST',
        url: '/otp/verify',
        payload: { email: 'otp-brute@example.com', code: '123456' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('rate-limits OTP send (OTP_SEND: 5/min) with 429', async () => {
    captureCodes();
    const { server } = await authServer(true);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await server.inject({
        method: 'POST',
        url: '/otp/send',
        payload: { email: `otp-spam-${i}@example.com` },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe('role gating on the full app (memory driver actors)', () => {
  const key = () => ({ 'idempotency-key': `login-${Math.random().toString(36).slice(2)}` });

  it('admin routes: guest/partner (non-admin) refused, platform admin allowed', async () => {
    await services
      .repos()
      .platformAdmins.save(
        createPlatformAdmin({ id: 'ops_login', email: 'ops-login@c1rcle.test', role: 'ops' }),
      );
    const server = await buildApp({});
    open.push(server);

    const anon = await server.inject({
      method: 'GET',
      url: '/api/v2/admin/onboarding/applications',
    });
    expect([401, 403]).toContain(anon.statusCode);

    const guest = await server.inject({
      method: 'GET',
      url: '/api/v2/admin/onboarding/applications',
      headers: { 'x-user-id': 'guest_login' },
    });
    expect([401, 403]).toContain(guest.statusCode);

    const partner = await server.inject({
      method: 'GET',
      url: '/api/v2/admin/audit',
      headers: { 'x-user-id': 'partner_login', 'x-organization-id': 'org_login' },
    });
    expect([401, 403]).toContain(partner.statusCode);

    const admin = await server.inject({
      method: 'GET',
      url: '/api/v2/admin/onboarding/applications',
      headers: { 'x-user-id': 'ops_login' },
    });
    expect(admin.statusCode, admin.body).toBe(200);
  });

  it('org routes: X-Organization-Id must equal the path org (403), matching passes', async () => {
    const server = await buildApp({});
    open.push(server);
    const created = await server.inject({
      method: 'POST',
      url: '/api/v2/organizations',
      headers: { 'x-user-id': 'owner_login', ...key() },
      payload: { name: 'Login Org', slug: `login-org-${Date.now()}` },
    });
    expect(created.statusCode, created.body).toBe(201);
    const org: string = created.json().id;

    const mismatch = await server.inject({
      method: 'GET',
      url: `/api/v2/organizations/${org}/access`,
      headers: { 'x-user-id': 'owner_login', 'x-organization-id': 'org_other' },
    });
    expect(mismatch.statusCode).toBe(403);

    const missing = await server.inject({
      method: 'GET',
      url: `/api/v2/organizations/${org}/access`,
      headers: { 'x-user-id': 'owner_login' },
    });
    expect(missing.statusCode).toBeGreaterThanOrEqual(400);
    expect(missing.statusCode).toBeLessThan(500);

    const ok = await server.inject({
      method: 'GET',
      url: `/api/v2/organizations/${org}/access`,
      headers: { 'x-user-id': 'owner_login', 'x-organization-id': org },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().role).toEqual(expect.any(String));

    // Org data under another tenant's header is refused too.
    const crossRead = await server.inject({
      method: 'GET',
      url: `/api/v2/organizations/${org}/venues`,
      headers: { 'x-user-id': 'owner_login', 'x-organization-id': 'org_other' },
    });
    expect(crossRead.statusCode).toBe(403);
  });
});
