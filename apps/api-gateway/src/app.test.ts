import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

describe('app bootstrap + internal routes', () => {
  it('serves /api/v2/internal/health', async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/api/v2/internal/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });

  it('echoes x-request-id', async () => {
    const app = await buildApp({});
    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/internal/health',
      headers: { 'x-request-id': 'req-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-123');
    await app.close();
  });

  it('404s blocked/unknown v2 routes with the canonical envelope (never 501)', async () => {
    const app = await buildApp({});
    // Out-of-scope slice path (payments) must 404 by absence.
    const res = await app.inject({ method: 'POST', url: '/api/v2/organizations/org_1/payments' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    // Flat envelope — matches every route-level error send. A wrapped
    // `{ error: {...} }` shape here would encode the bug this session (and
    // independently, Sagar's parallel B10 work) found and fixed.
    expect(body.code).toBe('not_found');
    expect(body.requestId).toBeDefined();
    await app.close();
  });

  it('GET /api/v2/internal/version returns semantic version', async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/api/v2/internal/version' });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().version).toBe('string');
    await app.close();
  });

  it('CORS preflight allows PATCH/PUT/DELETE from a trusted frontend origin', async () => {
    // @fastify/cors defaults `methods` to 'GET,HEAD,POST' — narrower than the v2 API
    // actually uses (e.g. the onboarding autosave PATCH). Regression for that gap.
    const app = await buildApp({});
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/api/v2/onboarding/applications/req_1',
        headers: {
          origin: 'http://localhost:3001',
          'access-control-request-method': method,
        },
      });
      expect(res.headers['access-control-allow-methods']).toContain(method);
    }
    await app.close();
  });
});
