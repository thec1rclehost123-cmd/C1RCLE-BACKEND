import { adminTicketListResponseSchema, paginationQuerySchema } from '@c1rcle/contracts/client';

import type { Entitlement } from '@c1rcle/core/domain';

import { csvEscape } from '../../../lib/csv.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';

/**
 * ─── Admin tickets desk (Phase 7 admin) ──────────────────────────────────────
 * Platform-wide, read-only entitlement (ticket) ledger for the admin
 * `/tickets` dashboard. Distinct from a support-ticket desk — this is the
 * thing a guest presents at the door. Mirrors the admin orders desk pattern:
 * `services.adminOps.listTickets` runs `AdminAuthorityService.requireAdmin`
 * internally, responses use the frozen `paginatedSchema` envelope.
 */

const services = createV2Services();

const ticketsQuerySchema = paginationQuerySchema;

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
