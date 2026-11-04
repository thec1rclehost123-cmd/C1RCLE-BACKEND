import {
  opaqueIdSchema,
  organizationOverviewDtoSchema,
  organizationSalesBreakdownDtoSchema,
  organizationTrendsDtoSchema,
  organizationCalendarDtoSchema,
  organizationEventCardListResponseSchema,
  eventAnalyticsDtoSchema,
  eventPromoterAnalyticsDtoSchema,
  trendGranularitySchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 partner analytics (Phase 1) ──────────────────────────────────────────
 *
 * Read model first, compute-on-request fallback: the cached model stays the
 * fast path, and when the projection that fills it has not run yet these routes
 * do a bounded scan of source aggregates instead of returning fabricated
 * zeroes (see `AnalyticsService`'s doc comment). A dashboard load is still
 * cheap — the fallback is bounded by a per-collection scan cap.
 *
 * Organization analytics use the short-lived ORGANIZATION response cache to
 * avoid repeating bounded scans. Successful authenticated writes flush this
 * cache in-process so event and relationship changes are visible on refresh;
 * the TTL remains a fallback for external writes or missed invalidation. The
 * cache is process-local, so multi-instance deployments need shared
 * invalidation or must accept up to one TTL of cross-instance staleness.
 *
 * `/trends` and `/calendar` are also cached, on the same reasoning — and both
 * are *derived* from the same bounded scan rather than read from a projection,
 * so their cache is the only thing standing between a dashboard render and a
 * full collection walk. That is the whole reason they are not a single fat
 * `/overview` payload: a dashboard that fetches the month grid, the trend chart
 * and the summary together would want them cached independently anyway.
 */

const services = createV2Services();

const organizationIdParam = z.object({ organizationId: opaqueIdSchema });
const eventIdParam = z.object({ eventId: opaqueIdSchema });
const analyticsHeaders = z.looseObject({ 'x-organization-id': opaqueIdSchema });

/** `YYYY-MM-DD`. Bounds are validated here, clamped further in the service. */
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date');
const isoMonth = z.string().regex(/^\d{4}-\d{2}$/, 'Expected a YYYY-MM month');

/**
 * `granularity` defaults to `day` so a caller that only wants a week of daily
 * points does not have to say so, while an explicit `hour` or `month` is
 * honoured rather than silently coerced.
 */
const trendsQuery = z.object({
  from: isoDay,
  to: isoDay,
  granularity: trendGranularitySchema.default('day'),
});
const calendarQuery = z.object({ month: isoMonth });

/**
 * Bounded and defaulted. A dashboard shows a fixed number of cards, and an
 * unbounded `limit` would let one request ask for every event in the org.
 */
const cardQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

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

  fastify.get(
    '/organizations/:organizationId/analytics/sales-breakdown',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: organizationIdParam, headers: analyticsHeaders }),
        fastify.requirePermission('organization.read'),
        fastify.cached('ORGANIZATION'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const actor = services.actor(request);
      const breakdown = await services.analytics
        .getOrganizationSalesBreakdown(actor)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (breakdown === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        organizationSalesBreakdownDtoSchema,
        breakdown,
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── ORGANIZATION TRENDS ──────────────────────────────────────────────────
  fastify.get(
    '/organizations/:organizationId/analytics/trends',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: organizationIdParam,
          querystring: trendsQuery,
          headers: analyticsHeaders,
        }),
        fastify.requirePermission('organization.read'),
        fastify.cached('ORGANIZATION'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const { from, to, granularity } = request.query as z.infer<typeof trendsQuery>;
      const actor = services.actor(request);
      const trends = await services.analytics
        .getOrganizationTrends(actor, from, to, granularity)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (trends === undefined) return reply;

      const validated = validateV2Response(reply, request, organizationTrendsDtoSchema, trends);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── ORGANIZATION EVENT CARDS ────────────────────────────────────────────
  fastify.get(
    '/organizations/:organizationId/analytics/events',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: organizationIdParam,
          querystring: cardQuery,
          headers: analyticsHeaders,
        }),
        fastify.requirePermission('organization.read'),
        fastify.cached('ORGANIZATION'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const { limit } = request.query as z.infer<typeof cardQuery>;
      const actor = services.actor(request);
      const items = await services.analytics
        .getOrganizationEventCards(actor, limit)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (items === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        organizationEventCardListResponseSchema,
        { organizationId, items },
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── ORGANIZATION CALENDAR ────────────────────────────────────────────────
  fastify.get(
    '/organizations/:organizationId/analytics/calendar',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: organizationIdParam,
          querystring: calendarQuery,
          headers: analyticsHeaders,
        }),
        fastify.requirePermission('organization.read'),
        fastify.cached('ORGANIZATION'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const { month } = request.query as z.infer<typeof calendarQuery>;
      const actor = services.actor(request);
      const calendar = await services.analytics
        .getOrganizationCalendar(actor, month)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (calendar === undefined) return reply;

      const validated = validateV2Response(reply, request, organizationCalendarDtoSchema, calendar);
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

  fastify.get(
    '/events/:eventId/promoter-analytics',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: eventIdParam, headers: analyticsHeaders }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const actor = services.actor(request);
      const analytics = await services.analytics
        .getEventPromoterAnalytics(actor, eventId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (analytics === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        eventPromoterAnalyticsDtoSchema,
        analytics,
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}
