import {
  assignSupportTicketSchema,
  changeSupportTicketPrioritySchema,
  idempotencyKeySchema,
  mergeSupportTicketSchema,
  opaqueIdSchema,
  resolveSupportTicketSchema,
  supportTicketDtoSchema,
  supportTicketLinkSchema,
  supportTicketListResponseSchema,
  supportTicketMessageSchema,
  supportTicketQuerySchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { SupportTicket } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { requestMeta } from '../../../lib/v2-request-meta.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin support desk (Phase 7) ─────────────────────────────────────────────
 *
 * The ticket desk over `SupportTicket` (see
 * `packages/core/src/domain/models/support-ticket.ts` for the full design
 * record: real per-priority SLA, merge with absorbed-into bookkeeping, and
 * every mutation TIER1 — any platform admin may act, always logged, so no new
 * `AdminAction` entry was needed in `admin-authority.ts`).
 *
 * Guest/requester intake (submit / my tickets / follow-up) lives in
 * `routes/v2/support/intake-routes.ts`.
 */

const services = createV2Services();

const supportIdParam = z.object({ ticketId: opaqueIdSchema });
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });

function toSupportTicketDto(ticket: SupportTicket) {
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

export default async function adminSupportRoutes(fastify: FastifyInstance) {
  /* ─── Reads ──────────────────────────────────────────────────────────────── */

  fastify.get(
    '/admin/support/tickets',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: supportTicketQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof supportTicketQuerySchema>;

      const page = await services.adminSupport
        .listTickets(
          userId,
          {
            status: query.status,
            priority: query.priority,
            category: query.category,
            assigneeUserId: query.assigneeUserId,
            requesterUserId: query.requesterUserId,
            search: query.search,
            includeDeleted: query.includeDeleted === 'true',
          },
          { limit: query.limit, cursor: query.cursor ?? null },
        )
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
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
    '/admin/support/tickets/:ticketId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: supportIdParam })],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { ticketId } = request.params as z.infer<typeof supportIdParam>;

      const ticket = await services.adminSupport
        .getTicket(userId, ticketId)
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

  /* ─── Desk mutations ─────────────────────────────────────────────────────── */

  // The full-body verbs (assign / priority / link / reply / note / resolve /
  // merge) and the body-free verbs (escalate / close / reopen / restore) all
  // follow the same runIdempotent pattern as `admin/refunds.ts`.

  fastify.post(
    '/admin/support/tickets/:ticketId/assign',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: supportIdParam,
          headers: commandHeaders,
          body: assignSupportTicketSchema,
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { ticketId } = request.params as z.infer<typeof supportIdParam>;
      const body = request.body as z.infer<typeof assignSupportTicketSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.support.assign',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { ticketId }, body },
        run: async () => {
          const ticket = await services.adminSupport.assign(
            userId,
            ticketId,
            { userId: body.userId, name: body.name },
            requestMeta(request),
          );
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

  fastify.post(
    '/admin/support/tickets/:ticketId/priority',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: supportIdParam,
          headers: commandHeaders,
          body: changeSupportTicketPrioritySchema,
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { ticketId } = request.params as z.infer<typeof supportIdParam>;
      const body = request.body as z.infer<typeof changeSupportTicketPrioritySchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.support.change-priority',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { ticketId }, body },
        run: async () => {
          const ticket = await services.adminSupport.changePriority(
            userId,
            ticketId,
            body.priority,
            requestMeta(request),
          );
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

  fastify.post(
    '/admin/support/tickets/:ticketId/reply',
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
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { ticketId } = request.params as z.infer<typeof supportIdParam>;
      const body = request.body as z.infer<typeof supportTicketMessageSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.support.reply',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { ticketId }, body },
        run: async () => {
          const ticket = await services.adminSupport.sendAdminReply(
            userId,
            ticketId,
            body.content,
            requestMeta(request),
          );
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

  fastify.post(
    '/admin/support/tickets/:ticketId/notes',
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
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { ticketId } = request.params as z.infer<typeof supportIdParam>;
      const body = request.body as z.infer<typeof supportTicketMessageSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.support.note',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { ticketId }, body },
        run: async () => {
          const ticket = await services.adminSupport.addNote(
            userId,
            ticketId,
            body.content,
            requestMeta(request),
          );
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

  fastify.post(
    '/admin/support/tickets/:ticketId/link',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: supportIdParam,
          headers: commandHeaders,
          body: supportTicketLinkSchema,
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { ticketId } = request.params as z.infer<typeof supportIdParam>;
      const body = request.body as z.infer<typeof supportTicketLinkSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.support.link',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { ticketId }, body },
        run: async () => {
          const ticket = await services.adminSupport.link(
            userId,
            ticketId,
            {
              venueId: body.venueId,
              eventId: body.eventId,
              orderId: body.orderId,
              organizationId: body.organizationId,
              userId: body.userId,
            },
            requestMeta(request),
          );
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

  fastify.post(
    '/admin/support/tickets/:ticketId/resolve',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: supportIdParam,
          headers: commandHeaders,
          body: resolveSupportTicketSchema,
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { ticketId } = request.params as z.infer<typeof supportIdParam>;
      const body = request.body as z.infer<typeof resolveSupportTicketSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.support.resolve',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { ticketId }, body },
        run: async () => {
          const ticket = await services.adminSupport.resolve(
            userId,
            ticketId,
            body.reason,
            requestMeta(request),
          );
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

  fastify.post(
    '/admin/support/tickets/:ticketId/merge',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: supportIdParam,
          headers: commandHeaders,
          body: mergeSupportTicketSchema,
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { ticketId } = request.params as z.infer<typeof supportIdParam>;
      const body = request.body as z.infer<typeof mergeSupportTicketSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.support.merge',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { ticketId }, body },
        run: async () => {
          const { primary } = await services.adminSupport.merge(
            userId,
            ticketId,
            body.duplicateTicketId,
            requestMeta(request),
          );
          const validated = validateV2Response(
            reply,
            request,
            supportTicketDtoSchema,
            toSupportTicketDto(primary),
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

  // Body-free transitions share one handler: escalate / close / reopen /
  // restore differ only in the service call.
  const transition = (
    path: string,
    commandName: string,
    op: (
      userId: string,
      ticketId: string,
      meta: ReturnType<typeof requestMeta>,
    ) => Promise<SupportTicket>,
  ) =>
    fastify.post(
      path,
      {
        preHandler: [
          fastify.rateLimit('SENSITIVE_COMMAND'),
          fastify.validateV2({ params: supportIdParam, headers: commandHeaders }),
        ],
      },
      async (request, reply) => {
        const userId = requireUserId(request, reply);
        if (userId === undefined) return reply;
        const { ticketId } = request.params as z.infer<typeof supportIdParam>;
        const v2Headers = request.v2Headers ?? {};

        const result = await runIdempotent({
          idempotency: services.idempotency,
          request,
          actorId: userId,
          commandName,
          idempotencyKey: v2Headers['idempotency-key'],
          context: { path: { ticketId }, body: {} },
          run: async () => {
            const ticket = await op(userId, ticketId, requestMeta(request));
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

  transition(
    '/admin/support/tickets/:ticketId/escalate',
    'admin.support.escalate',
    (uid, tid, meta) => services.adminSupport.escalate(uid, tid, meta),
  );
  transition('/admin/support/tickets/:ticketId/close', 'admin.support.close', (uid, tid, meta) =>
    services.adminSupport.close(uid, tid, meta),
  );
  transition('/admin/support/tickets/:ticketId/reopen', 'admin.support.reopen', (uid, tid, meta) =>
    services.adminSupport.reopen(uid, tid, meta),
  );
  transition(
    '/admin/support/tickets/:ticketId/restore',
    'admin.support.restore',
    (uid, tid, meta) => services.adminSupport.restore(uid, tid, meta),
  );

  fastify.delete(
    '/admin/support/tickets/:ticketId',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: supportIdParam, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { ticketId } = request.params as z.infer<typeof supportIdParam>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.support.delete',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { ticketId }, body: {} },
        run: async () => {
          const ticket = await services.adminSupport.delete(userId, ticketId, requestMeta(request));
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
