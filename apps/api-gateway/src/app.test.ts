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
    // Flat envelope — the same shape every route sends, and the only shape the
    // frontend's ApiClientError can parse.
    expect(body).toMatchObject({ code: 'not_found', status: 404 });
    expect(body.requestId).toBeDefined();
    expect(body.error).toBeUndefined();
    await app.close();
  });

  it('GET /api/v2/internal/version returns semantic version', async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/api/v2/internal/version' });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().version).toBe('string');
    await app.close();
  });
});
