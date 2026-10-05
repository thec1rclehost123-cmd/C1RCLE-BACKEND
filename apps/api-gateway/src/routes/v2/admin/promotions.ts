import { adminPromoListResponseSchema, paginationQuerySchema } from '@c1rcle/contracts/client';

import type { PromoCode } from '@c1rcle/core/domain';

import { csvEscape } from '../../../lib/csv.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';

/**
 * ─── Admin promotions desk (Phase 7 admin) ───────────────────────────────────
 * Platform-wide, read-only promo code list for the admin `/promotions`
 * dashboard. Creation/editing stays a partner action, scoped to their own
 * event (`EventCatalogService.createPromotion`) — this is a cross-event
 * view, not a second write path.
 */

const services = createV2Services();

const promotionsQuerySchema = paginationQuerySchema;

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

function promoToDto(promo: PromoCode) {
  return {
    id: promo.id,
    eventId: promo.eventId,
    organizationId: promo.organizationId,
    code: promo.code,
    name: promo.name,
    type: promo.type,
    discountType: promo.discountType,
    discountValue: promo.discountValue,
    maxRedemptions: promo.maxRedemptions,
    redemptionCount: promo.redemptionCount,
    startsAt: promo.startsAt,
    endsAt: promo.endsAt,
    isActive: promo.isActive,
    createdAt: promo.createdAt,
  };
}

export default async function adminPromotionsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/admin/promotions',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: promotionsQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof promotionsQuerySchema>;

      const page = await services.adminOps
        .listPromotions(userId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        adminPromoListResponseSchema,
        listResponse(page.items.map(promoToDto), page.total, query.limit, page.nextCursor),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/admin/promotions/export.csv',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({})],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;

      const page = await services.adminOps
        .listPromotions(userId, { limit: 1000, cursor: null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const header = [
        'id',
        'eventId',
        'organizationId',
        'code',
        'name',
        'type',
        'discountType',
        'discountValue',
        'maxRedemptions',
        'redemptionCount',
        'isActive',
        'createdAt',
      ];
      const lines = page.items.map((promo) => {
        const dto = promoToDto(promo);
        return [
          csvEscape(dto.id),
          csvEscape(dto.eventId),
          csvEscape(dto.organizationId),
          csvEscape(dto.code),
          csvEscape(dto.name),
          csvEscape(dto.type),
          csvEscape(dto.discountType),
          csvEscape(dto.discountValue),
          csvEscape(dto.maxRedemptions),
          csvEscape(dto.redemptionCount),
          csvEscape(dto.isActive ? 'true' : 'false'),
          csvEscape(new Date(dto.createdAt).toISOString()),
        ].join(',');
      });
      const csv = [header.map(csvEscape).join(','), ...lines].join('\n');
      return reply
        .type('text/csv')
        .header('Content-Disposition', 'attachment; filename="promotions.csv"')
        .send(csv);
    },
  );
}
