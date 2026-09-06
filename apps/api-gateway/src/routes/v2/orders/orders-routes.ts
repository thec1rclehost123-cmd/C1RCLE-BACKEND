import {
  orderDtoSchema,
  ordersListResponseSchema,
  orderStatusResponseSchema,
  paginationQuerySchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { mapDomainError } from '../partner/events.js';

import { orderToDto } from './order-dto.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Guest order reads (Phase 4 PR3) ───────────────────────────────────────
 * `GET /orders`, `GET /orders/:id`, `GET /orders/:id/status` — the buyer's
 * own orders only (see `OrderService`'s doc comment for why there's no
 * organization-scoped listing here yet). A cross-user id reports 404, never
 * 403 — same IDOR-safe shape as every other V2 route.
 */

const services = createV2Services();
const orderIdParam = z.object({ id: z.string().min(3).max(64) });

export default async function orderRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/orders',
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

  fastify.get(
    '/orders/:id',
    { preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: orderIdParam })] },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof orderIdParam>;
      const actor = services.actor(request);
      const order = await services.orders
        .getById(id, actor)
        .catch((error: unknown) => mapDomainError(reply, request, id, error));
      if (order === undefined) return reply;
      const validated = validateV2Response(reply, request, orderDtoSchema, orderToDto(order));
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/orders/:id/status',
    { preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: orderIdParam })] },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof orderIdParam>;
      const actor = services.actor(request);
      const order = await services.orders
        .getStatus(id, actor)
        .catch((error: unknown) => mapDomainError(reply, request, id, error));
      if (order === undefined) return reply;
      const payload = {
        id: order.id,
        status: order.status,
        version: order.version,
        updatedAt: order.updatedAt,
      };
      const validated = validateV2Response(reply, request, orderStatusResponseSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}
