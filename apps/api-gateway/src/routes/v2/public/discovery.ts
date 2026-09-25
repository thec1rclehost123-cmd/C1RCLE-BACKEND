import {
  paginationQuerySchema,
  eventDtoSchema,
  eventPublicDetailDtoSchema,
  venuePublicDetailDtoSchema,
  hostPublicDtoSchema,
  discoveryFeedDtoSchema,
  publicTicketTierListResponseSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { effectiveTierPricePaise } from '@c1rcle/core/domain';
import { z } from 'zod';

import type { Organization, TicketTier } from '@c1rcle/core/domain';
import type { Organization, Venue } from '@c1rcle/core/domain';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { eventToDto, mapDomainError } from '../partner/events.js';
import { venueToDto } from '../partner/venues.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 public / discovery routes (Phase 4 PR1) ──────────────────────────────
 * Thin routes (D-005): validate → ONE `PublicService` call → serialize. No
 * `X-Organization-Id`, no `requirePermission` — everything here is meant to
 * be reachable by an anonymous guest, so `PUBLIC_READ` is the only policy.
 * Only published/discoverable resources are ever returned (enforced in
 * `PublicService`, not re-checked here) — never a draft/cancelled event, a
 * suspended venue, or a non-active organization.
 */

const services = createV2Services();

// Event ids are opaque (≤64 chars); slugs can run up to 80
// (`slugifyEventTitle` caps at 80) — the shared char class, wider bound.
const idOrSlugParam = z.object({
  idOrSlug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Invalid id or slug format'),
});

const slugParam = z.object({
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid slug format'),
});

const venueIdParam = z.object({
  venueId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Invalid venue id format'),
});

const organizationIdParam = z.object({
  organizationId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Invalid organization id format'),
});

const searchQuerySchema = paginationQuerySchema.extend({
  q: z.string().min(1).max(200),
});

const eventListSchema = paginatedSchema(eventDtoSchema);

export default async function publicDiscoveryRoutes(fastify: FastifyInstance) {
  // ── EVENTS LIST ────────────────────────────────────────────────────────────
  fastify.get(
    '/events',
    {
      preHandler: [
        fastify.rateLimit('PUBLIC_READ'),
        fastify.validateV2({ querystring: paginationQuerySchema }),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const page = await services.public.listEvents({
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
      const payload = {
        items: page.items.map(eventToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, eventListSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── EVENT DETAIL (by id or slug) ──────────────────────────────────────────
  fastify.get(
    '/events/:idOrSlug',
    {
      preHandler: [fastify.rateLimit('PUBLIC_READ'), fastify.validateV2({ params: idOrSlugParam })],
    },
    async (request, reply) => {
      const { idOrSlug } = request.params as z.infer<typeof idOrSlugParam>;
      const detail = await services.public
        .getEvent(idOrSlug)
        .catch((error: unknown) => mapDomainError(reply, request, idOrSlug, error));
      if (detail === undefined) return reply;
      const payload = {
        ...eventToDto(detail.event),
        venue: detail.venue === null ? null : eventVenueToDto(detail.venue),
        organizer: detail.organizer === null ? null : hostToDto(detail.organizer),
      };
      const validated = validateV2Response(reply, request, eventPublicDetailDtoSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── VENUE DETAIL BY ID ───────────────────────────────────────────────────
  // Registered BEFORE `/venues/:slug`: the literal `by-id` matches the slug
  // char class, so order is what keeps `/venues/by-id/:venueId` from being
  // captured as a slug lookup. Guests resolve an event's `venueId` (events
  // carry the id, not the slug) to display the venue name + city.
  fastify.get(
    '/venues/by-id/:venueId',
    {
      preHandler: [fastify.rateLimit('PUBLIC_READ'), fastify.validateV2({ params: venueIdParam })],
    },
    async (request, reply) => {
      const { venueId } = request.params as z.infer<typeof venueIdParam>;
      const venue = await services.public
        .getVenueById(venueId)
        .catch((error: unknown) => mapDomainError(reply, request, venueId, error));
      if (venue === undefined) return reply;
      const validated = validateV2Response(reply, request, venueDtoSchema, venueToDto(venue));
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── VENUE DETAIL (by slug) ─────────────────────────────────────────────────
  fastify.get(
    '/venues/:slug',
    {
      preHandler: [fastify.rateLimit('PUBLIC_READ'), fastify.validateV2({ params: slugParam })],
    },
    async (request, reply) => {
      const { slug } = request.params as z.infer<typeof slugParam>;
      const venue = await services.public
        .getVenue(slug)
        .catch((error: unknown) => mapDomainError(reply, request, slug, error));
      if (venue === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        venuePublicDetailDtoSchema,
        publicVenueToDto(venue),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── HOST / ORGANIZATION PUBLIC PROFILE BY ID ─────────────────────────────
  // Registered BEFORE `/hosts/:slug` for the same capture reason as the
  // venue by-id route above: guests resolve an event's `organizationId`.
  fastify.get(
    '/hosts/by-id/:organizationId',
    {
      preHandler: [
        fastify.rateLimit('PUBLIC_READ'),
        fastify.validateV2({ params: organizationIdParam }),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const org = await services.public
        .getHostById(organizationId)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (org === undefined) return reply;
      const validated = validateV2Response(reply, request, hostPublicDtoSchema, hostToDto(org));
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── HOST / ORGANIZATION PUBLIC PROFILE (by slug) ──────────────────────────
  fastify.get(
    '/hosts/:slug',
    {
      preHandler: [fastify.rateLimit('PUBLIC_READ'), fastify.validateV2({ params: slugParam })],
    },
    async (request, reply) => {
      const { slug } = request.params as z.infer<typeof slugParam>;
      const org = await services.public
        .getHost(slug)
        .catch((error: unknown) => mapDomainError(reply, request, slug, error));
      if (org === undefined) return reply;
      const validated = validateV2Response(reply, request, hostPublicDtoSchema, hostToDto(org));
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── DISCOVERY FEED (curated/featured aggregate) ───────────────────────────
  fastify.get(
    '/discovery',
    { preHandler: [fastify.rateLimit('PUBLIC_READ')] },
    async (request, reply) => {
      const events = await services.public.discovery();
      const payload = { items: events.map(eventToDto) };
      const validated = validateV2Response(reply, request, discoveryFeedDtoSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── SEARCH (query param `q`) ───────────────────────────────────────────────
  fastify.get(
    '/search',
    {
      preHandler: [
        fastify.rateLimit('PUBLIC_READ'),
        fastify.validateV2({ querystring: searchQuerySchema }),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof searchQuerySchema>;
      const page = await services.public.search(query.q, {
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
      const payload = {
        items: page.items.map(eventToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, eventListSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── EVENT TIERS (public sell surface) ─────────────────────────────────────
  // Active tiers for a public event with live availability. Non-public events
  // 404 here exactly like `GET /events/:idOrSlug` (no existence oracle).
  // Registered AFTER `/events/:idOrSlug` — no capture conflict (`/tiers`
  // suffix), but kept adjacent for readability.
  fastify.get(
    '/events/:idOrSlug/tiers',
    {
      preHandler: [fastify.rateLimit('PUBLIC_READ'), fastify.validateV2({ params: idOrSlugParam })],
    },
    async (request, reply) => {
      const { idOrSlug } = request.params as z.infer<typeof idOrSlugParam>;
      const rows = await services.public
        .listEventTiers(idOrSlug)
        .catch((error: unknown) => mapDomainError(reply, request, idOrSlug, error));
      if (rows === undefined) return reply;
      const payload = {
        items: rows.map(({ tier, availableQuantity }) => publicTierToDto(tier, availableQuantity)),
      };
      const validated = validateV2Response(
        reply,
        request,
        publicTicketTierListResponseSchema,
        payload,
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}

/** Public-safe host DTO: no `role` (that's the caller's membership, and
 * there is no caller here), no settings, no member list. */
function hostToDto(org: Organization) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
  };
}

/**
 * Public-safe tier projection: identity + display + effective price + live
 * availability. No purchase bounds, no sales windows, no version stamps.
 * Legacy tiers without `priceInPaise` price via `effectiveTierPricePaise`.
 */
function publicTierToDto(tier: TicketTier, availableQuantity: number) {
  return {
    id: tier.id,
    eventId: tier.eventId,
    name: tier.name,
    description: tier.description,
    priceInPaise: effectiveTierPricePaise(tier),
    currency: tier.currency,
    availableQuantity,
  };
}
