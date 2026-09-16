import {
  adminPromoterAssignmentListResponseSchema,
  paginationQuerySchema,
} from '@c1rcle/contracts/client';

import type { PromoterAssignment } from '@c1rcle/core/domain';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';

/**
 * ─── Admin promoters desk (Phase 7 admin) ────────────────────────────────────
 * V2 has no standalone "promoter" entity — a promoter is an `Organization`
 * member with a versioned commission assignment per event
 * (`PromoterAssignment`). Platform-wide, read-only listing for the admin
 * `/promoters` dashboard.
 */

const services = createV2Services();

const promotersQuerySchema = paginationQuerySchema;

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
}
