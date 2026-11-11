import {
  adminEventDtoSchema,
  idempotencyKeySchema,
  opaqueIdSchema,
  externalVenueReviewDecisionSchema,
  externalVenueReviewQueueItemSchema,
} from '@c1rcle/contracts/client';
import {
  decideExternalLocationReview,
  EventNotFoundError,
  ForbiddenError,
} from '@c1rcle/core/domain';
import { z } from 'zod';

import type { Event } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { requestMeta } from '../../../lib/v2-request-meta.js';
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
  const reviewer = async (userId: string) => {
    const admin = await services.adminAuthority.requireAdmin(userId);
    if (!['admin', 'ops', 'super'].includes(admin.role))
      throw new Error('External venue review requires an admin, ops, or super role');
    return admin;
  };

  fastify.get(
    '/admin/external-venue-requests',
    {
      preHandler: [fastify.rateLimit('AUTH_READ')],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      try {
        await reviewer(userId);
        const page = await services.repos().events.listAll({ limit: 1000, cursor: null });
        const items = page.items.flatMap((event) => {
          const location = event.externalLocation;
          if (!location || location.review.status !== 'pending') return [];
          return [
            {
              eventId: event.id,
              organizationId: event.organizationId,
              title: event.title,
              location: {
                name: location.name,
                address: location.address,
                ...(location.city ? { city: location.city } : {}),
                ...(location.region ? { region: location.region } : {}),
                ...(location.postalCode ? { postalCode: location.postalCode } : {}),
                ...(location.country ? { country: location.country } : {}),
                ...(location.mapUrl ? { mapUrl: location.mapUrl } : {}),
                contact: location.contact,
              },
              status: location.review.status,
              submittedAt: location.review.submittedAt,
              rejectionReason: location.review.rejectionReason,
            },
          ];
        });
        return await reply.send({
          items: z.array(externalVenueReviewQueueItemSchema).parse(items),
        });
      } catch (error) {
        return reply
          .status(403)
          .send({
            code: 'forbidden',
            message: error instanceof Error ? error.message : 'Forbidden',
          });
      }
    },
  );

  fastify.post(
    '/admin/events/:eventId/external-venue-review',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: eventIdParam,
          body: externalVenueReviewDecisionSchema,
          headers: commandHeaders,
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const body = request.body as z.infer<typeof externalVenueReviewDecisionSchema>;
      const headers = request.v2Headers ?? {};
      const admin = await reviewer(userId).catch((error: unknown) => {
        reply
          .status(403)
          .send({
            code: 'forbidden',
            message: error instanceof Error ? error.message : 'Forbidden',
          });
        return undefined;
      });
      if (!admin) return reply;
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.external_venue.review',
        idempotencyKey: headers['idempotency-key'],
        context: { path: { eventId }, body },
        run: async () => {
          const event = await services.repos().events.getById(eventId);
          if (!event?.externalLocation) throw new EventNotFoundError(eventId);
          const organization = await services.repos().organizations.getById(event.organizationId);
          if (
            organization?.ownerId === userId ||
            organization?.members.some(
              (member) => member.userId === userId && member.capabilities.includes('host'),
            )
          )
            throw new ForbiddenError('Hosts cannot review their own external venue requests');
          const updated = decideExternalLocationReview(event, {
            approved: body.decision === 'approve',
            reviewerId: userId,
            reason: body.reason,
            now: services.config().clock.now(),
          });
          await services.repos().events.save(updated);
          await services.adminAudits().append({
            id: services.config().ids(),
            adminId: userId,
            adminRole: admin.role,
            action:
              body.decision === 'approve' ? 'EXTERNAL_VENUE_APPROVE' : 'EXTERNAL_VENUE_REJECT',
            targetType: 'event',
            targetId: eventId,
            organizationId: event.organizationId,
            before: { venueReviewStatus: event.externalLocation.review.status },
            after: {
              venueReviewStatus: updated.externalLocation?.review.status,
              rejectionReason: updated.externalLocation?.review.rejectionReason,
            },
            reason: body.reason ?? null,
            occurredAt: services.config().clock.now().getTime(),
          });
          return { statusCode: 200, body: eventToDto(updated) };
        },
      }).catch((error: unknown) => mapDomainError(reply, request, eventId, error));
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

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
          const event = await services.adminOps.pauseEvent(userId, eventId, requestMeta(request));
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
          const event = await services.adminOps.resumeEvent(userId, eventId, requestMeta(request));
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
    '/admin/events/:eventId/force-complete',
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
        commandName: 'admin.event.force_complete',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { eventId }, body: {} },
        run: async () => {
          const event = await services.adminOps.forceCompleteEvent(
            userId,
            eventId,
            requestMeta(request),
          );
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
