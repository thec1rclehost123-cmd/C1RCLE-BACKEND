import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import cachePlugin from './cache.js';

describe('response cache tenant isolation', () => {
  it('does not serve one verified organization’s cached response to another', async () => {
    const app = Fastify({ logger: false });
    await app.register(cachePlugin, { enabled: true });
    app.addHook('onRequest', async (request) => {
      request.actor = {
        userId: String(request.headers['x-test-user'] ?? ''),
        organizationId: String(request.headers['x-test-org'] ?? ''),
        role: 'owner',
        capabilities: [],
        platformRole: 'guest',
      };
    });
    app.get('/same-url', { preHandler: [app.cached('EVENT_PREVIEW')] }, async (request) => ({
      organizationId: request.actor?.organizationId,
      userId: request.actor?.userId,
    }));

    const first = await app.inject({
      method: 'GET',
      url: '/same-url',
      headers: { 'x-test-org': 'org_alpha', 'x-test-user': 'user_alpha' },
    });
    const otherTenant = await app.inject({
      method: 'GET',
      url: '/same-url',
      headers: { 'x-test-org': 'org_bravo', 'x-test-user': 'user_bravo' },
    });
    const firstAgain = await app.inject({
      method: 'GET',
      url: '/same-url',
      headers: { 'x-test-org': 'org_alpha', 'x-test-user': 'user_alpha' },
    });

    expect(first.json()).toEqual({ organizationId: 'org_alpha', userId: 'user_alpha' });
    expect(first.headers['x-cache']).toBe('MISS');
    expect(otherTenant.json()).toEqual({ organizationId: 'org_bravo', userId: 'user_bravo' });
    expect(otherTenant.headers['x-cache']).toBe('MISS');
    expect(firstAgain.json()).toEqual({ organizationId: 'org_alpha', userId: 'user_alpha' });
    expect(firstAgain.headers['x-cache']).toBe('HIT');
    await app.close();
  });

  it('invalidates organization reads after a successful tenant write', async () => {
    const app = Fastify({ logger: false });
    await app.register(cachePlugin, { enabled: true });
    app.addHook('onRequest', async (request) => {
      request.actor = {
        userId: String(request.headers['x-test-user'] ?? 'user_alpha'),
        organizationId: String(request.headers['x-test-org'] ?? 'org_alpha'),
        role: 'owner',
        capabilities: [],
        platformRole: 'guest',
      };
    });
    let revision = 1;
    app.get('/analytics', { preHandler: [app.cached('ORGANIZATION')] }, async () => ({ revision }));
    app.post('/events', async () => {
      revision = 2;
      return { created: true };
    });

    const initial = await app.inject({ method: 'GET', url: '/analytics' });
    const cached = await app.inject({ method: 'GET', url: '/analytics' });
    await app.inject({
      method: 'GET',
      url: '/analytics',
      headers: { 'x-test-user': 'user_bravo' },
    });
    await app.inject({
      method: 'GET',
      url: '/analytics',
      headers: { 'x-test-user': 'user_charlie', 'x-test-org': 'org_bravo' },
    });
    const write = await app.inject({ method: 'POST', url: '/events' });
    const refreshed = await app.inject({ method: 'GET', url: '/analytics' });
    const otherMemberRefreshed = await app.inject({
      method: 'GET',
      url: '/analytics',
      headers: { 'x-test-user': 'user_bravo' },
    });
    const otherTenantRefreshed = await app.inject({
      method: 'GET',
      url: '/analytics',
      headers: { 'x-test-user': 'user_charlie', 'x-test-org': 'org_bravo' },
    });

    expect(initial.json()).toEqual({ revision: 1 });
    expect(cached.headers['x-cache']).toBe('HIT');
    expect(write.statusCode).toBe(200);
    expect(refreshed.json()).toEqual({ revision: 2 });
    expect(refreshed.headers['x-cache']).toBe('MISS');
    expect(otherMemberRefreshed.json()).toEqual({ revision: 2 });
    expect(otherMemberRefreshed.headers['x-cache']).toBe('MISS');
    expect(otherTenantRefreshed.headers['x-cache']).toBe('MISS');
    await app.close();
  });

  it('does not invalidate organization reads for a failed tenant write', async () => {
    const app = Fastify({ logger: false });
    await app.register(cachePlugin, { enabled: true });
    app.addHook('onRequest', async (request) => {
      request.actor = {
        userId: 'user_alpha',
        organizationId: 'org_alpha',
        role: 'owner',
        capabilities: [],
        platformRole: 'guest',
      };
    });
    app.get('/analytics', { preHandler: [app.cached('ORGANIZATION')] }, async () => ({ ok: true }));
    app.post('/events', async (_request, reply) => reply.status(500).send({ error: 'failed' }));

    await app.inject({ method: 'GET', url: '/analytics' });
    await app.inject({ method: 'POST', url: '/events' });
    const stillCached = await app.inject({ method: 'GET', url: '/analytics' });

    expect(stillCached.headers['x-cache']).toBe('HIT');
    await app.close();
  });
});
