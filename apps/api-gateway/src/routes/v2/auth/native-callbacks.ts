import { getBetterAuthTrustedOrigins, getGatewayConfig } from '../../../config/index.js';
import { toWebHeaders } from '../../../plugins/auth.js';

import type { BetterAuthInstance } from '../../../plugins/auth.js';
import type { FastifyInstance } from 'fastify';

/** Expose only required native callbacks, not Better Auth's full account API. */
export async function registerNativeCallbacks(app: FastifyInstance, auth: BetterAuthInstance) {
  app.post(
    '/google',
    {
      preHandler: app.rateLimit('SENSITIVE_COMMAND'),
    },
    async (request, reply) => {
      const config = getGatewayConfig();
      const origin = request.headers.origin;
      if (!origin || !getBetterAuthTrustedOrigins(config).includes(origin)) {
        return reply.status(403).send({ message: 'Authentication request unavailable.' });
      }
      const body = request.body as { next?: unknown } | null;
      const next = body?.next;
      if (
        typeof next !== 'string' ||
        !next.startsWith('/') ||
        next.startsWith('//') ||
        next.includes('\\') ||
        // eslint-disable-next-line no-control-regex -- reject control characters in redirect paths
        /[\u0000-\u001f\u007f]/.test(next) ||
        new URL(next, origin).origin !== origin
      ) {
        return reply.status(400).send({ message: 'Invalid return destination.' });
      }
      const response = await auth.handler(
        new Request(new URL('/api/v2/auth/sign-in/social', config.BETTER_AUTH_URL), {
          method: 'POST',
          headers: {
            ...Object.fromEntries(toWebHeaders(request.headers)),
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            provider: 'google',
            callbackURL: new URL(next, origin).href,
            errorCallbackURL: new URL('/login?reason=google', origin).href,
            disableRedirect: true,
          }),
        }),
      );
      reply.status(response.status);
      reply.header('cache-control', 'no-store');
      reply.header('content-type', 'application/json');
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.send(await response.text());
    },
  );
  for (const path of ['/reset-password/:token', '/callback/google']) {
    app.get(path, async (request, reply) => {
      const url = new URL(request.raw.url ?? '', getGatewayConfig().BETTER_AUTH_URL);
      const response = await auth.handler(
        new Request(url, { headers: toWebHeaders(request.headers) }),
      );
      reply.status(response.status);
      for (const [name, value] of response.headers) {
        if (name !== 'set-cookie') reply.header(name, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header('set-cookie', cookies);
      reply.header('cache-control', 'no-store');
      return reply.send(await response.text());
    });
  }
}
