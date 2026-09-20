import {
  adminPromoterAssignmentListResponseSchema,
  adminPromoterActionResponseSchema,
  idempotencyKeySchema,
  opaqueIdSchema,
  paginationQuerySchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { PromoterAssignment } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { requestMeta } from '../../../lib/v2-request-meta.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin promoters desk (Phase 7 admin) ────────────────────────────────────
 * V2 has no standalone "promoter" entity — a promoter is an `Organization`
 * member with a versioned commission assignment per event
 * (`PromoterAssignment`). Platform-wide listing (read-only) plus
 * lifecycle actions (suspend / reinstate) for the admin `/promoters`
 * dashboard.
 *
 * `PROMOTER_SUSPEND`/`PROMOTER_REINSTATE` are TIER2 direct commands (same
 * idempotent, before/after-audited shape as venue suspend/reinstate): all of
 * a promoter user's assignments are bulk-transitioned, and a no-op repeat
 * returns 200 with `affectedAssignments: 0`.
 */

const services = createV2Services();

const promotersQuerySchema = paginationQuerySchema;
const promoterIdParam = z.object({ promoterId: opaqueIdSchema });
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });

function listResponse<T>(items: T[], total: number, limit: number, nextCursor: string | null) {
  return {
    items,
    pageInfo: {
      page: 1,
      pageSize: limit,
      total,
      hasNextPage: nextCursor !== null,
    },
  };
}

function assignmentToDto(assignment: PromoterAssignment) {
  return {
    id: assignment.id,
    eventId: assignment.eventId,
    promoterId: assignment.promoterId,
    status: assignment.status,
    ratePercent: assignment.terms.ratePercent,
    flatPaise: assignment.terms.flatPaise,
    createdAt: assignment.createdAt,
    endedAt: assignment.endedAt,
    suspendedAt: assignment.suspendedAt,
  };
}

export default async function adminPromotersRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/admin/promoters',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: promotersQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof promotersQuerySchema>;

      const page = await services.adminOps
        .listPromoterAssignments(userId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        adminPromoterAssignmentListResponseSchema,
        listResponse(page.items.map(assignmentToDto), page.total, query.limit, page.nextCursor),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/admin/promoters/:promoterId/suspend',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: promoterIdParam, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { promoterId } = request.params as z.infer<typeof promoterIdParam>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.promoter.suspend',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { promoterId }, body: {} },
        run: async () => {
          const outcome = await services.adminOps.suspendPromoter(
            userId,
            promoterId,
            requestMeta(request),
          );
          const validated = validateV2Response(reply, request, adminPromoterActionResponseSchema, {
            promoterId,
            action: 'suspended',
            affectedAssignments: outcome.affected,
            at: outcome.at.toISOString(),
          });
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, promoterId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, promoterId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.post(
    '/admin/promoters/:promoterId/reinstate',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: promoterIdParam, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { promoterId } = request.params as z.infer<typeof promoterIdParam>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.promoter.reinstate',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { promoterId }, body: {} },
        run: async () => {
          const outcome = await services.adminOps.reinstatePromoter(
            userId,
            promoterId,
            requestMeta(request),
          );
          const validated = validateV2Response(reply, request, adminPromoterActionResponseSchema, {
            promoterId,
            action: 'reinstated',
            affectedAssignments: outcome.affected,
            at: outcome.at.toISOString(),
          });
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, promoterId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, promoterId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}
