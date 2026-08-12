import { buildV2ErrorResponse } from '@c1rcle/contracts';
import { createLogger, type Logger } from '@c1rcle/core';
import Fastify, { type FastifyInstance } from 'fastify';

import authPlugin from './auth/auth-context.js';
import { getGatewayConfig, type GatewayConfig } from './config/index.js';
import { redactPaths } from './lib/logger-config.js';
import { genReqId, onRequestHook } from './lib/request-tracing.js';
import { getV2Services } from './lib/v2-services.js';
import cachePlugin from './plugins/cache.js';
import { errorHandler } from './plugins/error-handler.js';
import idempotencyPlugin from './plugins/idempotency.js';
import rateLimitPlugin from './plugins/rate-limit.js';
import rbacPlugin from './plugins/rbac.js';
import validateV2Plugin from './plugins/validate-v2.js';
import { registerV2Routes } from './routes/v2/route-manifest.js';

export interface BuildAppOptions {
  config?: GatewayConfig;
  logger?: Logger;
  /** Tests that are not about throttling can opt out of the limiter. */
  rateLimit?: boolean;
  /** Tests asserting freshness can opt out of the response cache. */
  cache?: boolean;
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

  // Order is deliberate: policy plugins decorate the instance, and routes
  // reference those decorators at registration time.
  const services = getV2Services(logger, config);
  await app.register(validateV2Plugin);
  await app.register(rateLimitPlugin, { enabled: options.rateLimit !== false });
  await app.register(authPlugin, {
    config,
    // The auth plugin proves membership against the SAME repository the
    // services write to — one store, one truth about who belongs where.
    organizations: services.repos().organizations,
  });
  await app.register(rbacPlugin);
  await app.register(cachePlugin, { enabled: options.cache !== false });
  await app.register(idempotencyPlugin);

  app.setErrorHandler((error, request, reply) => {
    errorHandler(logger, error, request, reply);
  });

  app.setNotFoundHandler((request, reply) => {
    const body = buildV2ErrorResponse({
      status: 404,
      message: `Route ${request.method} ${request.url} not found`,
      requestId: request.id,
    });
    // Flat envelope, exactly as the routes send it: the frontend's
    // ApiClientError reads `{ code, message, status, requestId }` at the top
    // level, so a wrapped body would be unparseable precisely on the errors it
    // most needs to understand.
    void reply.status(404).send(body);
  });

  await registerV2Routes(app);

  return app;
}
