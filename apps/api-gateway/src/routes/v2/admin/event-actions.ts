import {
  adminEventDtoSchema,
  idempotencyKeySchema,
  opaqueIdSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Event } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin event actions (Phase 7 admin) ─────────────────────────────────────
 *
 * `EVENT_PAUSE`/`EVENT_RESUME` are TIER1 — any active admin may call them,
 * the action is merely logged, no dual control. Same direct-command shape
 * as `venue-actions.ts`'s suspend/reinstate, just a lower tier.
 */

const services = createV2Services();

const eventIdParam = z.object({ eventId: opaqueIdSchema });
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });

function eventToDto(event: Event) {
  return {
    id: event.id,
    organizationId: event.organizationId,
    venueId: event.venueId,
    slug: event.slug,
    title: event.title,
    status: event.status,
    isPublic: event.isPublic,
    adminOverride: event.adminOverride,
    startAt: event.startAt,
    endAt: event.endAt,
    startingPricePaise: event.startingPricePaise,
    isFree: event.isFree,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

export default async function adminEventActionRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/admin/events/:eventId/pause',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: eventIdParam, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.event.pause',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { eventId }, body: {} },
        run: async () => {
          const event = await services.adminOps.pauseEvent(userId, eventId);
          const validated = validateV2Response(
            reply,
            request,
            adminEventDtoSchema,
            eventToDto(event),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, eventId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, eventId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.post(
    '/admin/events/:eventId/resume',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: eventIdParam, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.event.resume',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { eventId }, body: {} },
        run: async () => {
          const event = await services.adminOps.resumeEvent(userId, eventId);
          const validated = validateV2Response(
            reply,
            request,
            adminEventDtoSchema,
            eventToDto(event),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, eventId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, eventId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}
