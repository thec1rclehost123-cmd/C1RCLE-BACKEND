import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { getGatewayConfig } from './config/index.js';
import { createGatewayRuntimeState } from './lib/runtime-state.js';

function testConfig(overrides: Record<string, string> = {}) {
  return getGatewayConfig({
    NODE_ENV: 'test',
    STORAGE_DRIVER: 'memory',
    TRUSTED_PROXY_CIDRS: '127.0.0.1',
    ALLOWED_ORIGINS: 'http://localhost:3000,https://staging.example.test',
    BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3000,https://staging.example.test',
    ...overrides,
  });
}

describe('app bootstrap + internal routes', () => {
  it('serves /api/v2/internal/health', async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/api/v2/internal/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });

  it('does not accept a direct client x-request-id as the authoritative ID', async () => {
    const app = await buildApp({ config: testConfig({ TRUSTED_PROXY_CIDRS: '198.51.100.0/24' }) });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/internal/health',
      headers: { 'x-request-id': 'req-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).not.toBe('req-123');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });

  it('accepts forwarding headers and the request ID from a trusted proxy peer', async () => {
    const app = await buildApp({ config: testConfig() });
    app.get('/__test/proxy-context', async (request) => ({
      ip: request.ip,
      protocol: request.protocol,
      host: request.host,
      hostname: request.hostname,
    }));

    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const response = await fetch(`${address}/__test/proxy-context`, {
        headers: {
          Host: 'edge.example.test',
          'X-Forwarded-For': '203.0.113.10',
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'api.example.test',
          'X-Request-Id': 'edge-request-123',
        },
      });
      const body = (await response.json()) as Record<string, string>;
      expect(response.status).toBe(200);
      expect(body.ip).toBe('203.0.113.10');
      expect(body.protocol).toBe('https');
      expect(body.hostname).toBe('api.example.test');
      expect(response.headers.get('x-request-id')).toBe('edge-request-123');
    } finally {
      await app.close();
    }
  });

  it('ignores forwarding headers from an untrusted peer', async () => {
    const app = await buildApp({ config: testConfig({ TRUSTED_PROXY_CIDRS: '198.51.100.0/24' }) });
    app.get('/__test/proxy-context', async (request) => ({
      ip: request.ip,
      protocol: request.protocol,
      hostname: request.hostname,
    }));

    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const response = await fetch(`${address}/__test/proxy-context`, {
        headers: {
          'X-Forwarded-For': '203.0.113.10',
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'api.example.test',
          'X-Request-Id': 'client-request-123',
        },
      });
      const body = (await response.json()) as Record<string, string>;
      expect(response.status).toBe(200);
      expect(body.ip).toBe('127.0.0.1');
      expect(body.protocol).toBe('http');
      expect(body.hostname).not.toBe('api.example.test');
      expect(response.headers.get('x-request-id')).not.toBe('client-request-123');
    } finally {
      await app.close();
    }
  });

  it('allows configured origins and handles credentialed preflight', async () => {
    const app = await buildApp({ config: testConfig() });
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v2/internal/health',
      headers: { origin: 'https://staging.example.test' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://staging.example.test');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await app.inject({
      method: 'GET',
      url: '/api/v2/internal/health',
      headers: { origin: 'https://untrusted.example.test' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/v2/organizations',
      headers: {
        origin: 'https://staging.example.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Authorization, X-Organization-Id, Idempotency-Key',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');
    expect(preflight.headers['access-control-allow-headers']).toContain('Authorization');
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
    const app = await buildApp({
      config: testConfig({ APP_VERSION: '0.1.0-test', BUILD_SHA: 'abc123' }),
    });
    const res = await app.inject({ method: 'GET', url: '/api/v2/internal/version' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: '0.1.0-test', buildSha: 'abc123' });
    expect(typeof res.json().startedAt).toBe('string');
    await app.close();
  });

  it('returns 503 when a required readiness check fails', async () => {
    const app = await buildApp({
      config: testConfig(),
      readinessChecks: { firestore: () => false },
    });
    const res = await app.inject({ method: 'GET', url: '/api/v2/internal/readiness' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      ok: false,
      checks: { configuration: 'up', gateway: 'up', firestore: 'down' },
    });
    await app.close();
  });

  it('returns 503 when the gateway is shutting down', async () => {
    const runtimeState = createGatewayRuntimeState();
    const app = await buildApp({ config: testConfig(), runtimeState });
    runtimeState.markShuttingDown();

    const res = await app.inject({ method: 'GET', url: '/api/v2/internal/readiness' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      ok: false,
      checks: { configuration: 'up', gateway: 'down' },
    });
    await app.close();
  });
});
