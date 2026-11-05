import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import rateLimit from '../../../plugins/rate-limit.js';

import { registerNativeCallbacks } from './native-callbacks.js';

import type { BetterAuthInstance } from '../../../plugins/auth.js';

describe('native callback HTTP bridge', () => {
  it('preserves the callback query and separate cookies without exposing other native APIs', async () => {
    const handler = vi.fn(
      async (_request: Request) =>
        new Response(null, {
          status: 302,
          headers: [
            ['location', 'http://localhost:3000/reset-password?token=synthetic'],
            ['set-cookie', 'one=1; HttpOnly'],
            ['set-cookie', 'two=2; HttpOnly'],
          ],
        }),
    );
    const app = Fastify();
    await app.register(rateLimit, { enabled: true });
    await app.register(
      async (instance) =>
        registerNativeCallbacks(instance, { handler } as unknown as BetterAuthInstance),
      { prefix: '/api/v2/auth' },
    );
    const result = await app.inject(
      '/api/v2/auth/reset-password/synthetic?callbackURL=http%3A%2F%2Flocalhost%3A3000',
    );
    expect(result.statusCode).toBe(302);
    expect(handler.mock.calls[0]?.[0].url).toContain(
      '/api/v2/auth/reset-password/synthetic?callbackURL=',
    );
    expect(result.headers['set-cookie']).toHaveLength(2);
    expect(result.headers['cache-control']).toBe('no-store');
    expect((await app.inject('/api/v2/auth/delete-user')).statusCode).toBe(404);
    await app.close();
  });
});
