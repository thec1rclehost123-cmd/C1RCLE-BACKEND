import {
  adminTicketListResponseSchema,
  adminTicketEventChangeRefundReviewsSchema,
  adminTicketCoverReconciliationSchema,
  adminEventCoverReconciliationSchema,
  adminEventCoverReversalResponseSchema,
  adminTicketTransfersResponseSchema,
  paginationQuerySchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Entitlement } from '@c1rcle/core/domain';

import { csvEscape } from '../../../lib/csv.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin tickets desk (Phase 7 admin) ──────────────────────────────────────
 * Platform-wide entitlement (ticket) ledger and audited transfer recovery
 * actions for the admin `/tickets` dashboard. Distinct from a support-ticket
 * desk — this is the thing a guest presents at the door. Mirrors the admin orders desk pattern:
 * `services.adminOps.listTickets` runs `AdminAuthorityService.requireAdmin`
 * internally, responses use the frozen `paginatedSchema` envelope.
 */

const services = createV2Services();

const ticketsQuerySchema = paginationQuerySchema;
const ticketTransferParamsSchema = z.object({ ticketId: z.string().min(3).max(64) });
const eventCoverReconciliationParamsSchema = z.object({ eventId: z.string().min(3).max(64) });
const coverReversalParamsSchema = z.object({
  ticketId: z.string().min(3).max(64),
  captureEntryId: z.string().min(3).max(128),
});
const coverReversalBodySchema = z.object({ reason: z.string().trim().min(8).max(500) }).strict();
const freezeTransferParamsSchema = z.object({ transferId: z.string().min(3).max(64) });
const freezeTransferBodySchema = z.object({ reason: z.string().trim().min(5).max(500) }).strict();
const frozenTransferResponseSchema = z.object({
  id: z.string(),
  entitlementId: z.string(),
  eventId: z.string(),
  status: z.enum(['frozen', 'expired']),
  resolvedAt: z.iso.datetime(),
});
const releasedTransferResponseSchema = z.object({
  id: z.string(),
  entitlementId: z.string(),
  eventId: z.string(),
  status: z.literal('frozen'),
  lockReleased: z.literal(true),
});

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

function ticketToDto(ticket: Entitlement) {
  return {
    id: ticket.id,
    orderId: ticket.orderId,
    eventId: ticket.eventId,
    organizationId: ticket.organizationId,
    tierName: ticket.tierName,
    userId: ticket.userId,
    holderName: ticket.holderName,
    status: ticket.status,
    scanCountAllowed: ticket.scanCountAllowed,
    scanCount: ticket.scanCount,
    lastScannedAt: ticket.scannedAt.at(-1) ?? null,
    createdAt: ticket.createdAt,
  };
}

export default async function adminTicketsRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/admin/tickets/:ticketId/cover-redemptions/:captureEntryId/reverse',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: coverReversalParamsSchema, body: coverReversalBodySchema }),
      ],
    },
    async (request, reply) => {
      const adminUserId = requireUserId(request, reply);
      if (adminUserId === undefined) return reply;
      reply.header('cache-control', 'private, no-store');
      const { ticketId, captureEntryId } = request.params as z.infer<
        typeof coverReversalParamsSchema
      >;
      const { reason } = request.body as z.infer<typeof coverReversalBodySchema>;
      const result = await services.adminOps
        .reverseTicketCoverRedemption(adminUserId, ticketId, captureEntryId, reason, {
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        })
        .catch((error: unknown) => mapDomainError(reply, request, ticketId, error));
      if (result === undefined) return reply;
      const validated = validateV2Response(reply, request, adminEventCoverReversalResponseSchema, {
        accountId: result.accountId,
        entitlementId: result.entitlementId,
        reversalEntryId: result.entry.id,
        reversedEntryId: result.entry.reversesEntryId,
        amountPaise: result.entry.amountPaise,
        remainingPaise: result.account.remainingPaise,
        redeemedPaise: result.account.redeemedPaise,
        settlementStatus: 'held',
        settlementEligible: false,
        replayed: result.replayed,
      });
      if (validated === undefined) return reply;
      return reply.code(200).send(validated);
    },
  );

  fastify.get(
    '/admin/events/:eventId/cover-reconciliation',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: eventCoverReconciliationParamsSchema }),
      ],
    },
    async (request, reply) => {
      const adminUserId = requireUserId(request, reply);
      if (adminUserId === undefined) return reply;
      reply.header('cache-control', 'private, no-store');
      const { eventId } = request.params as z.infer<typeof eventCoverReconciliationParamsSchema>;
      const reconciliation = await services.adminOps
        .getEventCoverReconciliation(adminUserId, eventId)
        .catch((error: unknown) => mapDomainError(reply, request, eventId, error));
      if (reconciliation === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        adminEventCoverReconciliationSchema,
        reconciliation,
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/admin/tickets/:ticketId/cover-reconciliation',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: ticketTransferParamsSchema }),
      ],
    },
    async (request, reply) => {
      const adminUserId = requireUserId(request, reply);
      if (adminUserId === undefined) return reply;
      reply.header('cache-control', 'private, no-store');
      const { ticketId } = request.params as z.infer<typeof ticketTransferParamsSchema>;
      const reconciliation = await services.adminOps
        .getTicketCoverReconciliation(adminUserId, ticketId)
        .catch((error: unknown) => mapDomainError(reply, request, ticketId, error));
      if (reconciliation === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        adminTicketCoverReconciliationSchema,
        reconciliation,
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/admin/tickets/:ticketId/event-change-refund-reviews',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: ticketTransferParamsSchema }),
      ],
    },
    async (request, reply) => {
      const adminUserId = requireUserId(request, reply);
      if (adminUserId === undefined) return reply;
      reply.header('cache-control', 'private, no-store');
      const { ticketId } = request.params as z.infer<typeof ticketTransferParamsSchema>;
      const requests = await services.adminOps
        .listTicketEventChangeRefundReviews(adminUserId, ticketId)
        .catch((error: unknown) => mapDomainError(reply, request, ticketId, error));
      if (requests === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        adminTicketEventChangeRefundReviewsSchema,
        requests,
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/admin/tickets/:ticketId/transfers',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: ticketTransferParamsSchema }),
      ],
    },
    async (request, reply) => {
      const adminUserId = requireUserId(request, reply);
      if (adminUserId === undefined) return reply;
      reply.header('cache-control', 'private, no-store');
      const { ticketId } = request.params as z.infer<typeof ticketTransferParamsSchema>;
      const transfers = await services.adminOps
        .listTicketTransfersForAdmin(adminUserId, ticketId)
        .catch((error: unknown) => mapDomainError(reply, request, ticketId, error));
      if (transfers === undefined) return reply;
      const summaries = transfers
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
        )
        .slice(0, 50)
        .map((transfer) => ({
          id: transfer.id,
          entitlementId: transfer.entitlementId,
          eventId: transfer.eventId,
          recipientBinding: transfer.recipientUserId ? 'account' : 'verified_email',
          status: transfer.status,
          expiresAt: transfer.expiresAt,
          createdAt: transfer.createdAt,
          resolvedAt: transfer.resolvedAt,
        }));
      const validated = validateV2Response(
        reply,
        request,
        adminTicketTransfersResponseSchema,
        summaries,
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/admin/ticket-transfers/:transferId/freeze',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: freezeTransferParamsSchema, body: freezeTransferBodySchema }),
      ],
    },
    async (request, reply) => {
      const adminUserId = requireUserId(request, reply);
      if (adminUserId === undefined) return reply;
      const { transferId } = request.params as z.infer<typeof freezeTransferParamsSchema>;
      const { reason } = request.body as z.infer<typeof freezeTransferBodySchema>;
      const transfer = await services.adminOps
        .freezeTicketTransfer(adminUserId, transferId, reason, {
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        })
        .catch((error: unknown) => mapDomainError(reply, request, transferId, error));
      if (!transfer) return reply;
      const validated = validateV2Response(reply, request, frozenTransferResponseSchema, {
        id: transfer.id,
        entitlementId: transfer.entitlementId,
        eventId: transfer.eventId,
        status: transfer.status,
        resolvedAt: transfer.resolvedAt,
      });
      if (!validated) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/admin/ticket-transfers/:transferId/release',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: freezeTransferParamsSchema, body: freezeTransferBodySchema }),
      ],
    },
    async (request, reply) => {
      const adminUserId = requireUserId(request, reply);
      if (adminUserId === undefined) return reply;
      const { transferId } = request.params as z.infer<typeof freezeTransferParamsSchema>;
      const { reason } = request.body as z.infer<typeof freezeTransferBodySchema>;
      const transfer = await services.adminOps
        .releaseFrozenTicketTransfer(adminUserId, transferId, reason, {
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        })
        .catch((error: unknown) => mapDomainError(reply, request, transferId, error));
      if (!transfer) return reply;
      const validated = validateV2Response(reply, request, releasedTransferResponseSchema, {
        id: transfer.id,
        entitlementId: transfer.entitlementId,
        eventId: transfer.eventId,
        status: transfer.status,
        lockReleased: true,
      });
      if (!validated) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/admin/tickets',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: ticketsQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      reply.header('cache-control', 'private, no-store');
      const query = request.query as z.infer<typeof ticketsQuerySchema>;

      const page = await services.adminOps
        .listTickets(userId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        adminTicketListResponseSchema,
        listResponse(page.items.map(ticketToDto), page.total, query.limit, page.nextCursor),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/admin/tickets/export.csv',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({})],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      reply.header('cache-control', 'private, no-store');

      const page = await services.adminOps
        .listTickets(userId, { limit: 1000, cursor: null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const header = [
        'id',
        'orderId',
        'eventId',
        'organizationId',
        'tierName',
        'userId',
        'holderName',
        'status',
        'scanCount',
        'scanCountAllowed',
        'createdAt',
      ];
      const lines = page.items.map((ticket) => {
        const dto = ticketToDto(ticket);
        return [
          csvEscape(dto.id),
          csvEscape(dto.orderId),
          csvEscape(dto.eventId),
          csvEscape(dto.organizationId),
          csvEscape(dto.tierName),
          csvEscape(dto.userId),
          csvEscape(dto.holderName),
          csvEscape(dto.status),
          csvEscape(dto.scanCount),
          csvEscape(dto.scanCountAllowed),
          csvEscape(new Date(dto.createdAt).toISOString()),
        ].join(',');
      });
      const csv = [header.map(csvEscape).join(','), ...lines].join('\n');
      return reply
        .type('text/csv')
        .header('Content-Disposition', 'attachment; filename="tickets.csv"')
        .send(csv);
    },
  );
}
