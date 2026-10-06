import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { getGatewayConfig } from './config/index.js';

/**
 * ─── Browser cross-origin access ─────────────────────────────────────────────
 * Regression: the admin console (Vercel) calls the gateway (Render) straight
 * from the browser with `Authorization: Bearer` + `X-Request-ID`, which forces
 * a CORS preflight. The allow-list used to be hardcoded to the localhost dev
 * ports, so the production preflight came back without
 * `Access-Control-Allow-Origin` and the browser never sent the GET — while the
 * same request made server-side (curl, tests) returned 200.
 */

const ADMIN_ORIGIN = 'https://c1rcle-v2-admin-console.vercel.app';
const QUEUE_URL = '/api/v2/admin/onboarding/applications?status=submitted&limit=100';

async function appAllowing(origins: string) {
  return buildApp({ config: { ...getGatewayConfig(), ALLOWED_ORIGINS: origins } });
}

function preflight(origin: string, method = 'GET') {
  return {
    method: 'OPTIONS' as const,
    url: QUEUE_URL,
    headers: {
      origin,
      'access-control-request-method': method,
      'access-control-request-headers': 'authorization,x-request-id',
    },
  };
}

describe('CORS', () => {
  it('lets a configured origin preflight an authenticated admin GET', async () => {
    const app = await appAllowing(ADMIN_ORIGIN);
    const res = await app.inject(preflight(ADMIN_ORIGIN));
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ADMIN_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(String(res.headers['access-control-allow-headers'])).toMatch(/authorization/i);
    expect(String(res.headers['access-control-allow-headers'])).toMatch(/x-request-id/i);
    await app.close();
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('allows %s in the preflight', async (method) => {
    const app = await appAllowing(ADMIN_ORIGIN);
    const res = await app.inject(preflight(ADMIN_ORIGIN, method));
    expect(String(res.headers['access-control-allow-methods'])).toContain(method);
    await app.close();
  });

  it('echoes the allowed origin on the actual response, not a wildcard', async () => {
    const app = await appAllowing(ADMIN_ORIGIN);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/internal/health',
      headers: { origin: ADMIN_ORIGIN },
    });
    expect(res.headers['access-control-allow-origin']).toBe(ADMIN_ORIGIN);
    await app.close();
  });

  it('grants nothing to an origin that is not on the list', async () => {
    const app = await appAllowing(ADMIN_ORIGIN);
    const res = await app.inject(preflight('https://evil.example.com'));
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('does not loosen authorization for an allowed origin', async () => {
    const app = await appAllowing(ADMIN_ORIGIN);
    // A non-admin caller from the allowed origin is still refused.
    const res = await app.inject({
      method: 'GET',
      url: QUEUE_URL,
      headers: { origin: ADMIN_ORIGIN, 'x-user-id': 'not_an_admin' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(ADMIN_ORIGIN);
    await app.close();
  });
});
