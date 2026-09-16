import { adminOrderListResponseSchema, paginationQuerySchema } from '@c1rcle/contracts/client';

import type { Order } from '@c1rcle/core/domain';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';

/**
 * ─── Admin orders desk (Phase 7 admin) ───────────────────────────────────────
 * Platform-wide, read-only order list for the admin `/orders` dashboard.
 * Mirrors the admin directory pattern exactly: `services.adminOps.listOrders`
 * runs `AdminAuthorityService.requireAdmin` internally, responses use the
 * frozen `paginatedSchema` envelope, and money stays in paise.
 *
 * Status (including `refunded`/`refund_requested`) and `refundedPaise` are
 * already denormalized onto the `Order` aggregate, so the refund state join
 * needs no additional read — the desk filters client-side over the page.
 */

const services = createV2Services();

const ordersQuerySchema = paginationQuerySchema;

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

function orderToDto(order: Order) {
  return {
    id: order.id,
    eventId: order.eventId,
    organizationId: order.organizationId,
    userId: order.userId,
    status: order.status,
    ticketCount: order.lines.reduce((sum, line) => sum + line.quantity, 0),
    grandTotalPaise: order.grandTotalPaise,
    refundedPaise: order.refundedPaise,
    contact: order.contact,
    paymentId: order.paymentId,
    paidAt: order.paidAt,
    createdAt: order.createdAt,
  };
}

export default async function adminOrdersRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/admin/orders',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: ordersQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof ordersQuerySchema>;

      const page = await services.adminOps
        .listOrders(userId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        adminOrderListResponseSchema,
        listResponse(page.items.map(orderToDto), page.total, query.limit, page.nextCursor),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}
