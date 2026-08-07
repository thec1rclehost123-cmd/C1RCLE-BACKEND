import type { FastifyInstance } from 'fastify';

/**
 * ─── Internal endpoints (no auth) ─────────────────────────────────────────────
 * `/api/v2/internal/{health,version,readiness}` — used by load balancers,
 * probes, and the frontend's boot health checks.
 */

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  const version = '0.1.0';
  const startedAt = new Date().toISOString();

  await app.register(
    async (internal) => {
      internal.get('/health', async () => ({
        ok: true,
        uptimeMs: Date.now() - Date.parse(startedAt),
      }));

      internal.get('/version', async () => ({ version, startedAt }));

      internal.get('/readiness', async (_request, reply) => {
        // Readiness depends on infra (redis, firestore) once wired; for now the
        // gateway itself is the only dependency and it is serving this request.
        void reply.send({ ok: true, checks: { gateway: 'up' } });
      });
    },
    { prefix: '/internal' },
  );
}
