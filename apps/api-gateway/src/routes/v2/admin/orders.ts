import { buildV2ErrorResponse } from '@c1rcle/contracts';
import {
  adminOrderListResponseSchema,
  adminPromoterOrderInvestigationSchema,
  paginationQuerySchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Order } from '@c1rcle/core/domain';

import { csvEscape } from '../../../lib/csv.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

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
    '/admin/orders/by-booking-reference/:bookingReference',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: z.object({ bookingReference: z.string().trim().min(6).max(64) }),
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { bookingReference } = request.params as { bookingReference: string };
      const investigation = await services.adminOps
        .getPromoterOrderInvestigation(userId, bookingReference)
        .catch((error: unknown) => mapDomainError(reply, request, bookingReference, error));
      if (investigation === undefined) return reply;
      if (investigation === null) {
        return reply.status(404).send(
          buildV2ErrorResponse({
            status: 404,
            code: 'not_found',
            message: 'Order not found',
            requestId: request.id,
          }),
        );
      }
      const validated = validateV2Response(reply, request, adminPromoterOrderInvestigationSchema, {
        bookingReference: investigation.order.bookingReference ?? null,
        order: orderToDto(investigation.order),
        attribution: investigation.order.attribution
          ? {
              promoterId: investigation.order.attribution.promoterId,
              assignmentId: investigation.order.attribution.assignmentId,
              assignmentVersion: investigation.order.attribution.assignmentVersion,
              referralLinkId: investigation.order.attribution.referralLinkId,
              code: investigation.order.attribution.code,
              termsVersion: investigation.order.attribution.termsSnapshot.version,
              attributedAt: investigation.order.attribution.attributedAt,
              promoterCommissionPaise: investigation.order.attribution.promoterCommissionPaise,
              commissionPolicyVersion: investigation.order.attribution.commissionPolicyVersion,
              commercialPolicyVersion: investigation.order.attribution.commercialPolicyVersion,
            }
          : null,
        journals: investigation.journals.map((journal) => ({
          id: journal.id,
          sourceType: journal.source.type,
          sourceId: journal.source.id,
          assignmentId: journal.source.assignmentId ?? null,
          commissionPolicyVersion: journal.source.commissionPolicyVersion ?? null,
          commercialPolicyVersion: journal.source.commercialPolicyVersion ?? null,
          componentPromoterCommissionPaise: journal.components?.promoterAllocationPaise ?? null,
          reversalOfJournalId: journal.reversalOfJournalId,
          status: journal.status,
          postedAt: journal.postedAt,
        })),
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

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

  fastify.get(
    '/admin/orders/export.csv',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({})],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;

      const page = await services.adminOps
        .listOrders(userId, { limit: 1000, cursor: null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const header = [
        'id',
        'eventId',
        'organizationId',
        'userId',
        'status',
        'ticketCount',
        'grandTotalPaise',
        'refundedPaise',
        'paymentId',
        'createdAt',
      ];
      const lines = page.items.map((order) => {
        const dto = orderToDto(order);
        return [
          csvEscape(dto.id),
          csvEscape(dto.eventId),
          csvEscape(dto.organizationId),
          csvEscape(dto.userId),
          csvEscape(dto.status),
          csvEscape(dto.ticketCount),
          csvEscape(dto.grandTotalPaise),
          csvEscape(dto.refundedPaise),
          csvEscape(dto.paymentId),
          csvEscape(new Date(dto.createdAt).toISOString()),
        ].join(',');
      });
      const csv = [header.map(csvEscape).join(','), ...lines].join('\n');
      return reply
        .type('text/csv')
        .header('Content-Disposition', 'attachment; filename="orders.csv"')
        .send(csv);
    },
  );
}
