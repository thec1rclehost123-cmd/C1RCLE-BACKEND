import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { getGatewayConfig } from '../config/index.js';
import { resetV2Services } from '../lib/v2-services.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── B10: auth, tenancy and policy ───────────────────────────────────────────
 *
 * The gate: "a browser can log in, reload, and still be authenticated (cookie
 * restore), and the in-memory access token never appears in localStorage. IDOR
 * + rate-limit tests green."
 *
 * The reload path is the one that matters — it is the whole reason the durable
 * credential is an httpOnly cookie rather than a stored token.
 */

const CREDENTIALS = { email: 'partner@example.com', password: 'password12345' };

async function build(): Promise<FastifyInstance> {
  resetV2Services();
  return buildApp({ config: getGatewayConfig(), rateLimit: false });
}

async function signUp(app: FastifyInstance, email = CREDENTIALS.email) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v2/auth/sign-up',
    payload: { ...CREDENTIALS, email, displayName: 'Sky Partner' },
  });
  return {
    status: response.statusCode,
    body: response.json(),
    cookies: response.headers['set-cookie'],
  };
}

/** Extracts the raw Cookie header a browser would send back. */
function cookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  return values.map((value) => value.split(';')[0]).join('; ');
}

let app: FastifyInstance;

beforeEach(async () => {
  app = await build();
});

afterEach(async () => {
  await app.close();
  resetV2Services();
});

describe('auth — session lifecycle', () => {
  it('signs up and returns the frontend session contract', async () => {
    const { status, body } = await signUp(app);
    expect(status).toBe(201);
    expect(body.user).toMatchObject({ email: CREDENTIALS.email, role: 'partner' });
    expect(typeof body.accessToken).toBe('string');
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('sets an httpOnly session cookie the client script cannot read', async () => {
    const { cookies } = await signUp(app);
    const raw = Array.isArray(cookies) ? cookies.join(';') : String(cookies);
    expect(raw.toLowerCase()).toContain('httponly');
  });

  it('logs in and accepts the bearer token on a protected route', async () => {
    await signUp(app);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: CREDENTIALS,
    });
    expect(login.statusCode).toBe(200);
    const session = login.json();

    const organizations = await app.inject({
      method: 'GET',
      url: '/api/v2/partner/organizations',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        'x-organization-id': 'org_missing',
      },
    });
    // Authenticated, but not a member of that org yet → 403, never 401.
    expect(organizations.statusCode).toBe(403);
  });

  it('restores the session from the cookie alone — the page-reload path', async () => {
    const { cookies } = await signUp(app);

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/refresh',
      headers: { cookie: cookieHeader(cookies) },
    });

    expect(refreshed.statusCode).toBe(200);
    const session = refreshed.json();
    expect(session.user.email).toBe(CREDENTIALS.email);
    expect(session.accessToken.length).toBeGreaterThan(0);
  });

  it('refuses refresh without a cookie', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v2/auth/refresh' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('returns the session or 401 from GET /auth/session', async () => {
    const { cookies } = await signUp(app);

    const authed = await app.inject({
      method: 'GET',
      url: '/api/v2/auth/session',
      headers: { cookie: cookieHeader(cookies) },
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.json()).toMatchObject({ user: { email: CREDENTIALS.email } });

    const anonymous = await app.inject({ method: 'GET', url: '/api/v2/auth/session' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('revokes the session on logout', async () => {
    const { cookies } = await signUp(app);
    const cookie = cookieHeader(cookies);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v2/auth/session',
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('does not distinguish a wrong password from an unknown account', async () => {
    await signUp(app);
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { ...CREDENTIALS, password: 'wrong-password-123' },
    });
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { email: 'nobody@example.com', password: 'password12345' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json().message).toBe(unknownUser.json().message);
  });
});

describe('auth — protected routes and tenancy', () => {
  it('rejects an unauthenticated request to a partner route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/partner/organizations',
      headers: { 'x-organization-id': 'org_1' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthorized' });
  });

  it('rejects a forged bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/partner/organizations',
      headers: { authorization: 'Bearer not-a-real-token', 'x-organization-id': 'org_1' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('creates an organization, then scopes every later call to real membership', async () => {
    const { body } = await signUp(app);
    const bearer = `Bearer ${body.accessToken}`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/partner/organizations',
      headers: { authorization: bearer, 'idempotency-key': 'org-create-1' },
      payload: { name: 'Skyline', slug: 'skyline' },
    });
    expect(created.statusCode).toBe(201);
    const organizationId = created.json().id as string;

    // Now a member: the same token works when scoped to that organization.
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v2/partner/organizations',
      headers: { authorization: bearer, 'x-organization-id': organizationId },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
  });

  it('denies a second user access to the first user’s organization (IDOR)', async () => {
    const owner = await signUp(app, 'owner@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/partner/organizations',
      headers: { authorization: `Bearer ${owner.body.accessToken}`, 'idempotency-key': 'idor-1' },
      payload: { name: 'Skyline', slug: 'skyline-idor' },
    });
    const organizationId = created.json().id as string;

    const intruder = await signUp(app, 'intruder@example.com');
    const attempt = await app.inject({
      method: 'GET',
      url: `/api/v2/partner/organizations/${organizationId}`,
      headers: {
        authorization: `Bearer ${intruder.body.accessToken}`,
        'x-organization-id': organizationId,
      },
    });

    // Not a member → 403 before any service call; existence never confirmed.
    expect(attempt.statusCode).toBe(403);
  });

  it('rejects a header/path organization mismatch (ABAC)', async () => {
    const owner = await signUp(app, 'abac@example.com');
    const bearer = `Bearer ${owner.body.accessToken}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/partner/organizations',
      headers: { authorization: bearer, 'idempotency-key': 'abac-1' },
      payload: { name: 'Skyline', slug: 'skyline-abac' },
    });
    const organizationId = created.json().id as string;

    const mismatch = await app.inject({
      method: 'GET',
      url: `/api/v2/partner/organizations/${organizationId}`,
      // Header claims the org the caller belongs to; the path names another.
      headers: { authorization: bearer, 'x-organization-id': organizationId },
    });
    expect(mismatch.statusCode).toBe(200);

    const crossed = await app.inject({
      method: 'GET',
      url: '/api/v2/partner/organizations/org_someone_else',
      headers: { authorization: bearer, 'x-organization-id': organizationId },
    });
    expect(crossed.statusCode).toBe(403);
  });
});

describe('auth — rate limiting', () => {
  it('throttles the sensitive login bucket with Retry-After', async () => {
    const limited = await buildApp({ config: getGatewayConfig(), rateLimit: true });
    try {
      let last = await limited.inject({
        method: 'POST',
        url: '/api/v2/auth/login',
        payload: { email: 'nobody@example.com', password: 'password12345' },
      });
      for (let attempt = 0; attempt < 12 && last.statusCode !== 429; attempt++) {
        last = await limited.inject({
          method: 'POST',
          url: '/api/v2/auth/login',
          payload: { email: 'nobody@example.com', password: 'password12345' },
        });
      }
      expect(last.statusCode).toBe(429);
      expect(last.headers['retry-after']).toBeDefined();
      expect(last.json()).toMatchObject({ code: 'rate_limited', status: 429 });
    } finally {
      await limited.close();
    }
  });
});
