import { createGatewayRuntimeState, type GatewayRuntimeState } from '../../../lib/runtime-state.js';

import type { GatewayConfig } from '../../../config/index.js';
import type { ReadinessChecks } from '../route-manifest.js';
import type { FastifyInstance } from 'fastify';

/**
 * ─── Internal endpoints (no auth) ─────────────────────────────────────────────
 * `/api/v2/internal/{health,version,readiness}` — used by load balancers,
 * probes, and the frontend's boot health checks.
 */

export interface InternalRoutesOptions {
  config: GatewayConfig;
  runtimeState?: GatewayRuntimeState;
  readinessChecks?: ReadinessChecks;
}

export async function internalRoutes(
  app: FastifyInstance,
  options: InternalRoutesOptions,
): Promise<void> {
  const runtimeState = options.runtimeState ?? createGatewayRuntimeState();
  const readinessChecks = options.readinessChecks ?? {};

  await app.register(
    async (internal) => {
      internal.get('/health', async (_request, reply) => {
        void reply.header('cache-control', 'no-store');
        return {
          ok: true,
          uptimeMs: Date.now() - Date.parse(runtimeState.startedAt),
        };
      });

      internal.get('/version', async (_request, reply) => {
        void reply.header('cache-control', 'no-store');
        return {
          version: options.config.APP_VERSION,
          buildSha: options.config.BUILD_SHA,
          startedAt: runtimeState.startedAt,
        };
      });

      internal.get('/readiness', async (_request, reply) => {
        void reply.header('cache-control', 'no-store');
        const checks: Record<string, 'up' | 'down'> = {
          configuration: 'up',
          gateway: runtimeState.isShuttingDown ? 'down' : 'up',
        };

        for (const [name, check] of Object.entries(readinessChecks)) {
          try {
            checks[name] = (await check()) ? 'up' : 'down';
          } catch {
            checks[name] = 'down';
          }
        }

        const ok = Object.values(checks).every((status) => status === 'up');
        void reply.code(ok ? 200 : 503).send({ ok, checks });
      });
    },
    { prefix: '/internal' },
  );
}
