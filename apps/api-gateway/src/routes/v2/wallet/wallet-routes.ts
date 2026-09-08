import {
  entitlementsListResponseSchema,
  ordersListResponseSchema,
  paginationQuerySchema,
  walletSummaryDtoSchema,
} from '@c1rcle/contracts/client';
import { type z } from 'zod';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { orderToDto } from '../orders/order-dto.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Guest wallet (Phase 4 PR3) ─────────────────────────────────────────────
 * `GET /wallet` (light summary), `GET /wallet/tickets`, `GET /wallet/orders`
 * (the full lists) — projections of the same `OrderService`/`TicketService`
 * reads `orders-routes.ts`/`ticket-routes.ts` expose, scoped to the caller.
 * The wallet does not independently create or store anything (Dream doc
 * §"Wallet" — a wallet is a read projection, never its own authority).
 */

const services = createV2Services();

export default async function walletRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/wallet',
    { preHandler: [fastify.rateLimit('AUTH_READ')] },
    async (request, reply) => {
      const actor = services.actor(request);
      const summary = await Promise.resolve()
        .then(async () => {
          const tickets = await services.tickets.listForUser(actor, { limit: 100, cursor: null });
          const orders = await services.orders.listForUser(actor, { limit: 100, cursor: null });
          return {
            activeTicketCount: tickets.items.filter((t) => t.status === 'valid').length,
            upcomingOrderCount: orders.items.filter((o) => o.status === 'paid').length,
          };
        })
        .catch((error: unknown) => mapDomainError(reply, request, 'self', error));
      if (summary === undefined) return reply;
      const validated = validateV2Response(reply, request, walletSummaryDtoSchema, summary);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/wallet/tickets',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: paginationQuerySchema }),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.tickets
        .listForUser(actor, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, 'self', error));
      if (page === undefined) return reply;
      const payload = {
        items: page.items,
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, entitlementsListResponseSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/wallet/orders',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: paginationQuerySchema }),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.orders
        .listForUser(actor, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, 'self', error));
      if (page === undefined) return reply;
      const payload = {
        items: page.items.map(orderToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, ordersListResponseSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}
