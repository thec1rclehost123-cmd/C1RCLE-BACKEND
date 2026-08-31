import { buildV2ErrorResponse } from '@c1rcle/contracts';
import { createLogger, type Logger } from '@c1rcle/core';
import cors from '@fastify/cors';
import Fastify, { LogController, type FastifyInstance } from 'fastify';

import {
  createTrustedProxyMatcher,
  getAllowedOrigins,
  getGatewayConfig,
  getTrustedProxyCidrs,
  type GatewayConfig,
} from './config/index.js';
import { redactPaths } from './lib/logger-config.js';
import { createRequestIdGenerator, onRequestHook } from './lib/request-tracing.js';
import { createGatewayRuntimeState, type GatewayRuntimeState } from './lib/runtime-state.js';
import { createV2Services } from './lib/v2-services.js';
import cachePlugin from './plugins/cache.js';
import { errorHandler } from './plugins/error-handler.js';
import rateLimitPlugin from './plugins/rate-limit.js';
import rbacPlugin from './plugins/rbac.js';
import validateV2Plugin from './plugins/validate-v2.js';
import { registerV2Routes, type ReadinessChecks } from './routes/v2/route-manifest.js';

export interface BuildAppOptions {
  config?: GatewayConfig;
  logger?: Logger;
  runtimeState?: GatewayRuntimeState;
  readinessChecks?: ReadinessChecks;
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
  const runtimeState = options.runtimeState ?? createGatewayRuntimeState();
  const trustedProxyMatcher = createTrustedProxyMatcher(getTrustedProxyCidrs(config));

  const app = Fastify({
    trustProxy: (address) => trustedProxyMatcher(address),
    genReqId: createRequestIdGenerator(trustedProxyMatcher),
    logController: new LogController({ disableRequestLogging: true }),
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

  // Cookie-based sessions require credentials. Origins are explicit and
  // environment-driven so production cannot accidentally inherit localhost
  // behavior or enable wildcard credentialed CORS.
  await app.register(cors, {
    origin: getAllowedOrigins(config),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Organization-Id',
      'X-Request-Id',
      'X-Client-Request-Id',
      'Idempotency-Key',
      'If-Match',
    ],
    exposedHeaders: ['X-Request-Id'],
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
  // The RBAC plugin must resolve identity through the SAME path the routes do,
  // or policy would be evaluated against a different actor than the service
  // acts as (and would 401 everything on the memory driver).
  const v2Services = createV2Services();
  await app.register(rbacPlugin, {
    resolveActor: (request) => v2Services.actor(request),
  });
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

  await registerV2Routes(app, {
    config,
    runtimeState,
    readinessChecks: options.readinessChecks,
  });

  return app;
}
