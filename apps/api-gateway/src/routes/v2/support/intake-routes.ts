import {
  idempotencyKeySchema,
  opaqueIdSchema,
  paginationQuerySchema,
  submitSupportTicketSchema,
  supportTicketDtoSchema,
  supportTicketListResponseSchema,
  supportTicketMessageSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Guest support intake (Phase 7) ──────────────────────────────────────────
 * The intake side of the support desk. A signed-in guest opens a ticket and
 * follows up on their own tickets (`SupportService` scopes everything to the
 * actor's own `userId` — someone else's ticket is a 404, never a security
 * hint). SLA is set at creation from the ticket's priority — see
 * `packages/core/src/domain/models/support-ticket.ts`.
 *
 * The admin desk over the same aggregate is `admin/support.ts`.
 */

const services = createV2Services();

const supportIdParam = z.object({ ticketId: opaqueIdSchema });
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });

function toSupportTicketDto(ticket: {
  id: string;
  subject: string;
  description: string;
  category: string;
  status: string;
  priority: string;
  requester: unknown;
  assignee: unknown;
  messages: unknown;
  internalNotes: unknown;
  timeline: unknown;
  links: unknown;
  sla: unknown;
  mergedInto: unknown;
  mergedFrom: unknown;
  resolvedAt: unknown;
  resolvedBy: unknown;
  closedAt: unknown;
  closedBy: unknown;
  deletedAt: unknown;
  deletedBy: unknown;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: ticket.id,
    subject: ticket.subject,
    description: ticket.description,
    category: ticket.category,
    status: ticket.status,
    priority: ticket.priority,
    requester: ticket.requester,
    assignee: ticket.assignee,
    messages: ticket.messages,
    internalNotes: ticket.internalNotes,
    timeline: ticket.timeline,
    links: ticket.links,
    sla: ticket.sla,
    mergedInto: ticket.mergedInto,
    mergedFrom: ticket.mergedFrom,
    resolvedAt: ticket.resolvedAt,
    resolvedBy: ticket.resolvedBy,
    closedAt: ticket.closedAt,
    closedBy: ticket.closedBy,
    deletedAt: ticket.deletedAt,
    deletedBy: ticket.deletedBy,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

export default async function supportIntakeRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/support/tickets',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ headers: commandHeaders, body: submitSupportTicketSchema }),
      ],
    },
    async (request, reply) => {
      const actor = services.actor(request);
      const body = request.body as z.infer<typeof submitSupportTicketSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'support.ticket.submit',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: {}, body },
        run: async () => {
          const ticket = await services.support.submitTicket(actor.userId, {
            subject: body.subject,
            description: body.description,
            category: body.category,
            priority: body.priority,
            email: body.email ?? null,
            organizationId: body.organizationId ?? null,
          });
          const validated = validateV2Response(
            reply,
            request,
            supportTicketDtoSchema,
            toSupportTicketDto(ticket),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, actor.userId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, actor.userId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.get(
    '/support/tickets',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: paginationQuerySchema }),
      ],
    },
    async (request, reply) => {
      const actor = services.actor(request);
      const query = request.query as z.infer<typeof paginationQuerySchema>;

      const page = await services.support
        .listMyTickets(actor.userId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, actor.userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(reply, request, supportTicketListResponseSchema, {
        items: page.items.map(toSupportTicketDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/support/tickets/:ticketId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: supportIdParam })],
    },
    async (request, reply) => {
      const actor = services.actor(request);
      const { ticketId } = request.params as z.infer<typeof supportIdParam>;

      const ticket = await services.support
        .getMyTicket(actor.userId, ticketId)
        .catch((error: unknown) => mapDomainError(reply, request, ticketId, error));
      if (ticket === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        supportTicketDtoSchema,
        toSupportTicketDto(ticket),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/support/tickets/:ticketId/messages',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: supportIdParam,
          headers: commandHeaders,
          body: supportTicketMessageSchema,
        }),
      ],
    },
    async (request, reply) => {
      const actor = services.actor(request);
      const { ticketId } = request.params as z.infer<typeof supportIdParam>;
      const body = request.body as z.infer<typeof supportTicketMessageSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'support.ticket.message',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { ticketId }, body },
        run: async () => {
          const ticket = await services.support.sendMessage(actor.userId, ticketId, body.content);
          const validated = validateV2Response(
            reply,
            request,
            supportTicketDtoSchema,
            toSupportTicketDto(ticket),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, ticketId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, ticketId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}
