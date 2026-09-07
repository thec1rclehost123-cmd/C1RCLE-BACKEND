import { buildV2ErrorResponse } from '@c1rcle/contracts';
import {
  opaqueIdSchema,
  leaderboardQuerySchema,
  leaderboardStatResponseSchema,
  leaderboardTopResponseSchema,
} from '@c1rcle/contracts/client';
import { normalizeCity, periodBucketsFor } from '@c1rcle/core/domain';
import { z } from 'zod';

import type { LeaderboardStat } from '@c1rcle/core/domain';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── V2 Phase 6 promoter leaderboard ─────────────────────────────────────────
 * `GET /leaderboard` is public (v1 precedent + `public/discovery.ts`'s
 * `PUBLIC_READ` pattern — a ranking is not commercially sensitive the way a
 * balance or payout is). `GET /organizations/:organizationId/leaderboard/me`
 * is org-scoped like every other finance route (a promoter is itself an
 * organization — see the checkout-webhook integration's roadmap Session Log
 * entry) and reuses `organization.read`, same precedent as `finance-routes.ts`.
 */

const services = createV2Services();

const organizationIdParam = z.object({ organizationId: opaqueIdSchema });

/**
 * `periodValue` defaults to the CURRENT bucket for the requested
 * `periodType`/`city` when the caller omits it — computed the same way a
 * write would bucket "now", so `GET /leaderboard?periodType=month` always
 * means "this month" without the caller having to know the format.
 */
function resolvePeriodValue(
  periodType: 'all_time' | 'month' | 'week',
  city: string,
  provided: string | undefined,
): string {
  if (provided) return provided;
  const buckets = periodBucketsFor(new Date(), city);
  const match = buckets.find((b) => b.periodType === periodType && b.city === normalizeCity(city));
  return match?.periodValue ?? 'all';
}

export default async function leaderboardRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/leaderboard',
    {
      preHandler: [
        fastify.rateLimit('PUBLIC_READ'),
        fastify.validateV2({ querystring: leaderboardQuerySchema }),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof leaderboardQuerySchema>;
      const city = normalizeCity(query.city ?? 'global');
      const periodValue = resolvePeriodValue(query.periodType, city, query.periodValue);
      const items = await services.leaderboard.getTop(
        query.periodType,
        periodValue,
        city,
        query.limit,
      );
      const validated = validateV2Response(reply, request, leaderboardTopResponseSchema, {
        items: items.map(statToDto),
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/organizations/:organizationId/leaderboard/me',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: organizationIdParam, querystring: leaderboardQuerySchema }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const query = request.query as z.infer<typeof leaderboardQuerySchema>;
      const city = normalizeCity(query.city ?? 'global');
      const periodValue = resolvePeriodValue(query.periodType, city, query.periodValue);
      const actor = services.actor(request);
      const stat = await services.leaderboard
        .getMine(organizationId, query.periodType, periodValue, city, actor)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (stat === undefined) return reply;
      if (stat === null) {
        // No commission earned yet in this bucket — a real zero, not an
        // error. Return the shape a partner-dashboard chart can render
        // directly rather than a 404 for "hasn't sold anything yet".
        const empty: LeaderboardStat = {
          promoterId: organizationId,
          periodType: query.periodType,
          periodValue,
          city,
          totalCommissionEarnedPaise: 0,
          updatedAt: new Date(0).toISOString(),
        };
        const validated = validateV2Response(
          reply,
          request,
          leaderboardStatResponseSchema,
          statToDto(empty),
        );
        if (validated === undefined) return reply;
        return reply.send(validated);
      }
      const validated = validateV2Response(
        reply,
        request,
        leaderboardStatResponseSchema,
        statToDto(stat),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}

function statToDto(stat: LeaderboardStat) {
  return {
    promoterId: stat.promoterId,
    periodType: stat.periodType,
    periodValue: stat.periodValue,
    city: stat.city,
    totalCommissionEarnedPaise: stat.totalCommissionEarnedPaise,
    updatedAt: stat.updatedAt,
  };
}

/** Local copy — same per-file convention as `finance-routes.ts`. */
function mapDomainError(
  reply: FastifyReply,
  request: FastifyRequest,
  resourceId: string,
  error: unknown,
): undefined {
  const known = error as { code?: string; message?: string };
  if (known?.code === 'forbidden') {
    reply.status(403).send(
      buildV2ErrorResponse({
        status: 403,
        message: known.message ?? 'Forbidden',
        code: 'forbidden',
        requestId: request.id,
      }),
    );
    return undefined;
  }
  request.log.error({ resourceId, err: error }, 'unmapped_domain_error');
  reply.status(500).send(
    buildV2ErrorResponse({
      status: 500,
      message: 'Internal server error',
      code: 'server',
      requestId: request.id,
    }),
  );
  return undefined;
}
