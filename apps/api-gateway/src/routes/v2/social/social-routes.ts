import {
  createFollowSchema,
  followDtoSchema,
  followListResponseSchema,
  followStatusDtoSchema,
  followTargetParamsSchema,
  listMyFollowsQuerySchema,
  listNotificationsQuerySchema,
  markNotificationsReadSchema,
  markReadResultDtoSchema,
  notificationListResponseSchema,
  unreadCountDtoSchema,
} from '@c1rcle/contracts/client';

import type { Follow, SocialNotification, Page } from '@c1rcle/core/domain';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

/**
 * ─── Phase 8: follow graph + notification inbox ─────────────────────────────
 * Session-scoped guest surface, same posture as `profile.ts`: no
 * `X-Organization-Id`, no `requirePermission`, ownership = session user id.
 *
 * Follow/unfollow need no `Idempotency-Key`: the edge doc id is deterministic
 * per (follower, target), so a retry converges. POST answers 201 when the
 * edge was created and 200 when it already existed.
 *
 * Notifications are never written here — they are produced by bus
 * subscribers reacting to domain events (see `createFollowerFanOutConsumer`
 * wired in `lib/v2-services.ts`). These routes only read and mark read.
 */

const services = createV2Services();

type TargetParams = z.infer<typeof followTargetParamsSchema>;

function actorOrReply(request: FastifyRequest, reply: FastifyReply) {
  try {
    return services.actor(request);
  } catch (error: unknown) {
    mapDomainError(reply, request, 'session', error);
    return undefined;
  }
}

export default async function socialRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/follows',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: createFollowSchema }),
      ],
    },
    async (request, reply) => {
      const actor = actorOrReply(request, reply);
      if (actor === undefined) return reply;
      const body = request.body as z.infer<typeof createFollowSchema>;

      const result = await services.social
        .follow(actor, body.targetType, body.targetId)
        .catch((error: unknown) => mapDomainError(reply, request, actor.userId, error));
      if (result === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        followDtoSchema,
        toFollowDto(result.follow),
      );
      if (validated === undefined) return reply;
      return reply.status(result.created ? 201 : 200).send(validated);
    },
  );

  fastify.delete(
    '/follows/:targetType/:targetId',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: followTargetParamsSchema }),
      ],
    },
    async (request, reply) => {
      const actor = actorOrReply(request, reply);
      if (actor === undefined) return reply;
      const { targetType, targetId } = request.params as TargetParams;

      const done = await services.social
        .unfollow(actor, targetType, targetId)
        .then(() => true)
        .catch((error: unknown) => mapDomainError(reply, request, actor.userId, error));
      if (done === undefined) return reply;
      return reply.status(204).send();
    },
  );

  fastify.get(
    '/follows/me',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: listMyFollowsQuerySchema }),
      ],
    },
    async (request, reply) => {
      const actor = actorOrReply(request, reply);
      if (actor === undefined) return reply;
      const query = request.query as z.infer<typeof listMyFollowsQuerySchema>;

      const page = await services.social
        .listMyFollows(actor.userId, {
          limit: query.limit,
          cursor: query.cursor ?? null,
          targetType: query.targetType,
        })
        .catch((error: unknown) => mapDomainError(reply, request, actor.userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        followListResponseSchema,
        toListResponse(page, query.limit, toFollowDto),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/follows/:targetType/:targetId/status',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: followTargetParamsSchema }),
      ],
    },
    async (request, reply) => {
      const actor = actorOrReply(request, reply);
      if (actor === undefined) return reply;
      const { targetType, targetId } = request.params as TargetParams;

      const status = await services.social
        .followStatus(actor.userId, targetType, targetId)
        .catch((error: unknown) => mapDomainError(reply, request, actor.userId, error));
      if (status === undefined) return reply;

      const validated = validateV2Response(reply, request, followStatusDtoSchema, status);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/notifications/me',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: listNotificationsQuerySchema }),
      ],
    },
    async (request, reply) => {
      const actor = actorOrReply(request, reply);
      if (actor === undefined) return reply;
      const query = request.query as z.infer<typeof listNotificationsQuerySchema>;

      const page = await services.social
        .listNotifications(actor.userId, {
          limit: query.limit,
          cursor: query.cursor ?? null,
          unreadOnly: query.unreadOnly,
        })
        .catch((error: unknown) => mapDomainError(reply, request, actor.userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        notificationListResponseSchema,
        toListResponse(page, query.limit, toNotificationDto),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/notifications/me/unread-count',
    { preHandler: [fastify.rateLimit('AUTH_READ')] },
    async (request, reply) => {
      const actor = actorOrReply(request, reply);
      if (actor === undefined) return reply;

      const count = await services.social
        .unreadCount(actor.userId)
        .catch((error: unknown) => mapDomainError(reply, request, actor.userId, error));
      if (count === undefined) return reply;

      const validated = validateV2Response(reply, request, unreadCountDtoSchema, { count });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/notifications/me/read',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: markNotificationsReadSchema }),
      ],
    },
    async (request, reply) => {
      const actor = actorOrReply(request, reply);
      if (actor === undefined) return reply;
      const body = request.body as z.infer<typeof markNotificationsReadSchema>;

      const updated = await services.social
        .markRead(actor.userId, body.ids)
        .catch((error: unknown) => mapDomainError(reply, request, actor.userId, error));
      if (updated === undefined) return reply;

      const validated = validateV2Response(reply, request, markReadResultDtoSchema, { updated });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/notifications/me/read-all',
    { preHandler: [fastify.rateLimit('STANDARD_COMMAND')] },
    async (request, reply) => {
      const actor = actorOrReply(request, reply);
      if (actor === undefined) return reply;

      const updated = await services.social
        .markAllRead(actor.userId)
        .catch((error: unknown) => mapDomainError(reply, request, actor.userId, error));
      if (updated === undefined) return reply;

      const validated = validateV2Response(reply, request, markReadResultDtoSchema, { updated });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}

function toListResponse<TItem, TDto>(
  page: Page<TItem>,
  pageSize: number,
  toDto: (item: TItem) => TDto,
) {
  return {
    items: page.items.map(toDto),
    pageInfo: {
      page: 1,
      pageSize,
      total: page.total,
      hasNextPage: page.nextCursor !== null,
    },
    nextCursor: page.nextCursor,
  };
}

export function toFollowDto(follow: Follow) {
  return {
    id: follow.id,
    targetType: follow.targetType,
    targetId: follow.targetId,
    createdAt: follow.createdAt,
  };
}

export function toNotificationDto(notification: SocialNotification) {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    link: notification.link,
    subjectId: notification.subjectId,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
  };
}
