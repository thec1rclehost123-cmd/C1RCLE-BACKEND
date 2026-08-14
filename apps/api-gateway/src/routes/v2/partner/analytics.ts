import {
  opaqueIdSchema,
  organizationOverviewDtoSchema,
  eventAnalyticsDtoSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 partner analytics (Phase 1) ──────────────────────────────────────────
 *
 * Read-model only. Every number here was precomputed by a projection at write
 * time — these routes echo the cached model and never scan collections per
 * request, which is the rule that keeps a dashboard load cheap as an
 * organization's history grows.
 *
 * Both routes are cached: the read model is already slightly behind by design,
 * so a short TTL costs nothing in freshness that the projection lag has not
 * already spent.
 */

const services = createV2Services();

const organizationIdParam = z.object({ organizationId: opaqueIdSchema });
const eventIdParam = z.object({ eventId: opaqueIdSchema });
const analyticsHeaders = z.looseObject({ 'x-organization-id': opaqueIdSchema });

export default async function partnerAnalyticsRoutes(fastify: FastifyInstance) {
  // ── ORGANIZATION OVERVIEW ─────────────────────────────────────────────────
  fastify.get(
    '/organizations/:organizationId/analytics/overview',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: organizationIdParam, headers: analyticsHeaders }),
        // VIEW_ANALYTICS in the partner matrix maps to organization.read here:
        // the tenancy check is what actually gates the data.
        fastify.requirePermission('organization.read'),
        fastify.cached('ORGANIZATION'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const actor = services.actor(request);
      const overview = await services.analytics
        .getOrganizationOverview(actor)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (overview === undefined) return reply;

      // An organization with no history returns real zeroes, not an error —
      // an empty dashboard is a legitimate state, not a failure.
      const validated = validateV2Response(reply, request, organizationOverviewDtoSchema, overview);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── EVENT ANALYTICS ───────────────────────────────────────────────────────
  fastify.get(
    '/events/:eventId/analytics',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: eventIdParam, headers: analyticsHeaders }),
        fastify.requirePermission('event.read'),
        fastify.cached('EVENT_PREVIEW'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const actor = services.actor(request);
      const analytics = await services.analytics
        .getEventAnalytics(actor, eventId)
        .catch((error: unknown) =>
          // Cross-tenant and "no read model yet" both surface as not-found:
          // neither confirms whether someone else's event exists.
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (analytics === undefined) return reply;

      const validated = validateV2Response(reply, request, eventAnalyticsDtoSchema, analytics);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}
