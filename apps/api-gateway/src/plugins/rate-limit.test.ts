import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import rateLimitPlugin from './rate-limit.js';

describe('rate-limit compound key', () => {
  it('ignores the client-controlled X-Organization-Id header (no bucket rotation)', async () => {
    const app = Fastify();
    await app.register(rateLimitPlugin, { now: () => 1_000 });
    app.post('/otp', { preHandler: app.rateLimit('OTP_SEND') }, async () => ({ ok: true }));

    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/otp',
        headers: { 'x-organization-id': `org-${i}` },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    await app.close();
  });
});
