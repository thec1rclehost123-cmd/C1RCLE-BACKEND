import { eventComparisonResponseSchema, opaqueIdSchema } from '@c1rcle/contracts/client';
import { z } from 'zod';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

const services = createV2Services();
const params = z.object({ eventId: opaqueIdSchema });
const headers = z.looseObject({ 'x-organization-id': opaqueIdSchema });

export default async function eventComparisonRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/events/:eventId/comparison',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params, headers }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { eventId } = request.params as z.infer<typeof params>;
      const actor = services.actor(request);
      const result = await buildComparison(actor, eventId).catch((error: unknown) =>
        mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
      );
      if (!result) return reply;
      const validated = validateV2Response(reply, request, eventComparisonResponseSchema, result);
      return validated === undefined ? reply : reply.send(validated);
    },
  );
}

async function buildComparison(actor: ReturnType<typeof services.actor>, eventId: string) {
  const current = await services.events.get(actor, eventId);
  const currentAnalytics = await services.analytics.getEventAnalytics(actor, eventId);
  const previous = [];
  if (current.venueId) {
    const candidates = [];
    let cursor: string | null = null;
    // Bounded venue history scan: at most 500 records, in repository order.
    for (let page = 0; page < 5; page += 1) {
      const result = await services
        .repos()
        .events.listByVenue(current.venueId, { limit: 100, cursor });
      candidates.push(...result.items);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    const eligible = candidates
      .filter(
        (event) =>
          event.id !== current.id &&
          event.organizationId === actor.organizationId &&
          (event.status === 'ended' || event.status === 'archived'),
      )
      .sort((a, b) => b.startAt.localeCompare(a.startAt))
      .slice(0, 5);
    for (const event of eligible) {
      const analytics = await services.analytics.getEventAnalytics(actor, event.id);
      previous.push({
        eventId: event.id,
        title: event.title,
        startAt: event.startAt,
        status: 'final' as const,
        analytics,
      });
    }
  }
  return {
    current: {
      eventId: current.id,
      title: current.title,
      startAt: current.startAt,
      status: 'current' as const,
      analytics: currentAnalytics,
    },
    previous,
  };
}
