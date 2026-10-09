import { buildV2ErrorResponse } from '@c1rcle/contracts';
import { createLogger, type Logger } from '@c1rcle/core';
import cors from '@fastify/cors';
import Fastify, { LogController, type FastifyInstance } from 'fastify';

import {
  allowedBrowserOrigins,
  createTrustedProxyMatcher,
  getAllowedOrigins,
  getGatewayConfig,
  getTrustedProxyCidrs,
  type GatewayConfig,
} from './config/index.js';
import { redactPaths } from './lib/logger-config.js';
import {
  createMemoryRateLimitStore,
  createRedisRateLimitStore,
  type RateLimitStore,
} from './lib/rate-limit-store.js';
import { createReadinessChecks } from './lib/readiness.js';
import { createRedisClient, createRedisReadinessCheck } from './lib/redis.js';
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
  // Redis is only opened when something uses it: today that is the rate
  // limiter (RATE_LIMIT_STORE=redis). Otherwise nothing connects and readiness
  // doesn't report on a dependency the gateway doesn't have.
  const redis =
    config.RATE_LIMIT_STORE === 'redis' ? createRedisClient(config.REDIS_URL) : undefined;
  const readinessChecks =
    options.readinessChecks ??
    createReadinessChecks(config, {
      ...(redis ? { redisCheck: createRedisReadinessCheck(redis) } : {}),
      // Any Razorpay variable being set means payments are meant to work, so a
      // partial set (e.g. keys without the webhook secret) must show up here.
      // A deployment that sets none keeps the check off.
      paymentProviderActive: [
        config.RAZORPAY_KEY_ID,
        config.RAZORPAY_KEY_SECRET,
        config.RAZORPAY_WEBHOOK_SECRET,
      ].some(Boolean),
    });

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

  // Misconfigurations that are tolerated outside production but weaken a real
  // deployment. Production refuses to boot for the hard ones (config/index.ts).
  if (config.STORAGE_DRIVER === 'firestore') {
    if (!config.ENCRYPTION_KEY) {
      logger.warn('encryption_key_not_set', {
        hint: 'Bank account numbers are sealed with the built-in development key. Set ENCRYPTION_KEY.',
      });
    }
    const razorpaySet = [
      config.RAZORPAY_KEY_ID,
      config.RAZORPAY_KEY_SECRET,
      config.RAZORPAY_WEBHOOK_SECRET,
    ].filter(Boolean).length;
    if (razorpaySet < 3) {
      logger.warn('payments_not_configured', {
        configured: razorpaySet,
        of: 3,
        hint: 'Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET to enable payments.',
      });
    }
  }
  if (config.BETTER_AUTH_SECRET === 'dev-only-change-me' || config.BETTER_AUTH_SECRET.length < 32) {
    logger.warn('weak_auth_secret', {
      hint: 'BETTER_AUTH_SECRET is the development default or shorter than 32 characters.',
    });
  }

  let rateLimitStore: RateLimitStore = createMemoryRateLimitStore();
  if (redis) {
    // ioredis emits 'error' on every failed reconnect; unhandled, that is noisy
    // and (without a listener) alarming. The store already degrades to memory.
    redis.on('error', (error: Error) => {
      // Connection-refused arrives as an AggregateError with an empty message.
      const code = (error as { code?: string }).code;
      logger.warn('redis_error', {
        message: error.message === '' ? (code ?? error.name) : error.message,
      });
    });
    rateLimitStore = createRedisRateLimitStore(redis, {
      fallback: rateLimitStore,
      onError: (error) => {
        logger.warn('rate_limit_redis_unavailable_using_memory', {
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });
    app.addHook('onClose', async () => {
      await redis.quit().catch(() => {
        redis.disconnect();
      });
    });
  }

  app.addHook('onRequest', onRequestHook);

  // B10: cookie-based sessions require CORS credentials, and the frontends call
  // the gateway cross-origin (`localhost:300x` -> `:8080` in dev, Vercel ->
  // Render in production). Both origin sources are honoured: `ALLOWED_ORIGINS`
  // (server-side allow-list) and `CORS_ALLOWED_ORIGINS` (browser allow-list,
  // falling back to the 3 dev frontend ports outside production). Exact origins
  // only — never `*`, which browsers refuse alongside credentials anyway. See
  // docs/architecture/decisions.md D-001.
  //
  // Methods and headers are explicit: @fastify/cors v11 defaults to GET,HEAD,POST
  // only, which fails the preflight for the admin console's PUT/DELETE and the
  // partner dashboard's PATCH.
  await app.register(cors, {
    origin: [...new Set([...getAllowedOrigins(config), ...allowedBrowserOrigins(config)])],
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
      // Every authenticated door/scanner call carries this (see
      // `scanner-routes.ts`'s `sessionTokenFrom`) — missing from this list
      // means every such call fails CORS preflight from a browser (the
      // scanner-app web target), even though native RN callers, which don't
      // enforce CORS, never surfaced it.
      'X-Scanner-Session-Token',
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
  await app.register(rateLimitPlugin, { store: rateLimitStore });
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
    readinessChecks,
  });

  // v1 relied on Firebase Cloud Functions (`sweepExpiredCoverWallets`,
  // `cleanupReservations`) to physically clear expired cart holds and
  // scanner-session tokens. v2 has no Cloud Functions runtime, and both
  // repositories' `cleanupExpired` methods (explicitly documented as
  // "called by a worker") had no caller anywhere — correctness never
  // depended on it (every reader filters by `expiresAt`), but the documents
  // never got swept, so this restores the hygiene v1 had. Firestore-only:
  // the memory driver (tests) never spawns a timer.
  if (config.STORAGE_DRIVER === 'firestore') {
    const repos = v2Services.repos();
    const sweepIntervalMs = 5 * 60 * 1000;
    const sweepTimer = setInterval(() => {
      const now = new Date();
      void repos.cartReservations.cleanupExpired(now).catch((error: unknown) => {
        logger.error('cart reservation sweep failed', { error });
      });
      void repos.scannerSessions.cleanupExpired().catch((error: unknown) => {
        logger.error('scanner session sweep failed', { error });
      });
    }, sweepIntervalMs);
    sweepTimer.unref();
    app.addHook('onClose', (_instance, done) => {
      clearInterval(sweepTimer);
      done();
    });
  }

  return app;
}
