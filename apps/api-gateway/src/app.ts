import { buildV2ErrorResponse } from '@c1rcle/contracts';
import { createLogger, type Logger } from '@c1rcle/core';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import { getGatewayConfig, type GatewayConfig } from './config/index.js';
import { redactPaths } from './lib/logger-config.js';
import { genReqId, onRequestHook } from './lib/request-tracing.js';
import cachePlugin from './plugins/cache.js';
import { errorHandler } from './plugins/error-handler.js';
import rateLimitPlugin from './plugins/rate-limit.js';
import rbacPlugin from './plugins/rbac.js';
import validateV2Plugin from './plugins/validate-v2.js';
import { registerV2Routes } from './routes/v2/route-manifest.js';

export interface BuildAppOptions {
  config?: GatewayConfig;
  logger?: Logger;
}

/**
 * ─── Application factory ──────────────────────────────────────────────────────
 * Pure builder: no env reads here (config is injected), no side effects.
 * Tests call `buildApp()` and use Fastify's inject; the server entrypoint
 * calls it with real config and listens.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? getGatewayConfig();
  const injectedLogger: Logger | undefined = options.logger;
  const logLevel = config.LOG_LEVEL === 'silent' ? 'silent' : config.LOG_LEVEL;

  const app = Fastify({
    genReqId,
    disableRequestLogging: true,
    logger: {
      level: logLevel,
      redact: redactPaths,
    },
  });

  // Fastify's pino shapes `info(msg, fields)` — matches the Logger port.
  const logger =
    injectedLogger ??
    createLogger({
      info: (msg, fields) => {
        app.log.info(fields ?? {}, msg);
      },
      warn: (msg, fields) => {
        app.log.warn(fields ?? {}, msg);
      },
      error: (msg, fields) => {
        app.log.error(fields ?? {}, msg);
      },
    });

  app.addHook('onRequest', onRequestHook);

  // B10: cookie-based sessions require CORS credentials — the frontend apps
  // run on different ports (3000-3002) than this gateway (8080). Different
  // ports are still "same-site" for the SameSite cookie attribute (it only
  // considers scheme + registrable domain), so this is sufficient in local
  // dev without SameSite=None; prod cross-domain needs revisiting (see
  // docs/architecture/decisions.md D-001).
  await app.register(cors, {
    origin: ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'],
    credentials: true,
  });

  await app.register(validateV2Plugin);

  // B10: RBAC (`requirePermission`), rate limiting (`rateLimit`), and response
  // caching (`cached`) — ported from Sagar's parallel B10 work (this repo had
  // deferred all three). Decorators only at this point; `rateLimit` is
  // applied to the auth routes (routes/v2/auth/index.ts, the
  // credential-stuffing surface). `requirePermission`/`cached` are registered
  // and available but not yet wired into the partner routes — see
  // docs/roadmap/phase-00-foundation.md for why that's a deliberate, tracked
  // follow-up rather than a rushed per-route mapping.
  await app.register(rbacPlugin);
  await app.register(rateLimitPlugin);
  await app.register(cachePlugin);

  app.setErrorHandler((error, request, reply) => {
    errorHandler(logger, error, request, reply);
  });

  app.setNotFoundHandler((request, reply) => {
    const body = buildV2ErrorResponse({
      status: 404,
      message: `Route ${request.method} ${request.url} not found`,
      requestId: request.id,
    });
    // Flat envelope — see plugins/error-handler.ts for why this must never be
    // wrapped in `{ error: body }`.
    void reply.status(404).send(body);
  });

  await registerV2Routes(app);

  return app;
}
