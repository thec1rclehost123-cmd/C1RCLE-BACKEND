import {
  opaqueIdSchema,
  idempotencyKeySchema,
  paginationQuerySchema,
  notificationDtoSchema,
  notificationReadRequestSchema,
  notificationsListResponseSchema,
  markAllNotificationsReadResultSchema,
  notificationActionRequestSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Notification } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 partner notifications (inbox) ────────────────────────────────────────
 * Recipients are ORGANIZATIONS, so all four verbs are org-scoped from the
 * path param and gated by `organization.read` (the same permission the
 * connection/partnership resolution routes use). Quick actions delegate to
 * `NotificationService.performAction`, which routes to the resource's own
 * service — the receipt/party rules live there, not in this file.
 *
 * `mark-read`/`read-all` are naturally idempotent and therefore NOT wrapped in
 * `runIdempotent` — a client retry of the same PATCH simply resolves to the
 * already-read row. The action POST is a state-changing command, so it is
 * wrapped like every other action route.
 */

const services = createV2Services();

const organizationIdParam = z.object({ organizationId: opaqueIdSchema });
const notificationIdParam = z.object({
  organizationId: opaqueIdSchema,
  notificationId: opaqueIdSchema,
});

const readHeaders = z.looseObject({ 'x-organization-id': opaqueIdSchema });
const commandHeaders = readHeaders.extend({ 'idempotency-key': idempotencyKeySchema });

export default async function notificationRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/organizations/:organizationId/notifications',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: organizationIdParam,
          querystring: paginationQuerySchema,
          headers: readHeaders,
        }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.notifications
        .list(actor, organizationId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (page === undefined) return reply;

      const payload = {
        items: page.items.map(notificationToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
        unreadCount: page.unreadCount,
      };
      const validated = validateV2Response(
        reply,
        request,
        notificationsListResponseSchema,
        payload,
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.patch(
    '/organizations/:organizationId/notifications/read-all',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: organizationIdParam, headers: commandHeaders }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const actor = services.actor(request);
      const marked = await services.notifications
        .markAllRead(actor, organizationId)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (marked === undefined) return reply;

      const validated = validateV2Response(reply, request, markAllNotificationsReadResultSchema, {
        selected: marked,
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.patch(
    '/organizations/:organizationId/notifications/:notificationId/read',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: notificationIdParam,
          headers: readHeaders,
          body: notificationReadRequestSchema,
        }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { notificationId } = request.params as z.infer<typeof notificationIdParam>;
      const actor = services.actor(request);
      const notification = await services.notifications
        .markRead(actor, notificationId)
        .catch((error: unknown) => mapDomainError(reply, request, notificationId, error));
      if (notification === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        notificationDtoSchema,
        notificationToDto(notification),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/organizations/:organizationId/notifications/:notificationId/actions',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: notificationIdParam,
          headers: commandHeaders,
          body: notificationActionRequestSchema,
        }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { notificationId } = request.params as z.infer<typeof notificationIdParam>;
      const body = request.body as z.infer<typeof notificationActionRequestSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'notifications.action',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { notificationId }, body },
        run: async () => {
          const notification = await services.notifications.performAction(
            actor,
            notificationId,
            body.decision,
          );
          const validated = validateV2Response(
            reply,
            request,
            notificationDtoSchema,
            notificationToDto(notification),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, notificationId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, notificationId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}

function notificationToDto(notification: Notification) {
  return {
    id: notification.id,
    recipientId: notification.recipientId,
    recipientType: notification.recipientType,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    read: notification.read,
    readAt: notification.readAt,
    data: notification.data,
    action: notification.action,
    priority: notification.priority,
    createdAt: notification.createdAt,
  };
}
