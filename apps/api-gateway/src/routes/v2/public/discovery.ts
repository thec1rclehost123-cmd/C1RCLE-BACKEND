import {
  paginationQuerySchema,
  eventDtoSchema,
  venueDtoSchema,
  hostPublicDtoSchema,
  discoveryFeedDtoSchema,
  paginatedSchema,
  ticketTierDtoSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Organization, TicketTier } from '@c1rcle/core/domain';

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

const searchQuerySchema = paginationQuerySchema.extend({
  q: z.string().min(1).max(200),
});

const eventListSchema = paginatedSchema(eventDtoSchema);
const publicTierListSchema = z.array(ticketTierDtoSchema);
const promoterClickBodySchema = z
  .object({ eventSlug: z.string().min(1).max(80), code: z.string().min(4).max(16) })
  .strict();
const vanityParamsSchema = z.object({
  handle: z.string().min(1).max(60),
  slug: z.string().min(1).max(60),
});
const vanityResolutionSchema = z.object({ eventSlug: z.string(), code: z.string() });

export default async function publicDiscoveryRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/events/:idOrSlug/ticket-tiers',
    {
      preHandler: [fastify.rateLimit('PUBLIC_READ'), fastify.validateV2({ params: idOrSlugParam })],
    },
    async (request, reply) => {
      const { idOrSlug } = request.params as z.infer<typeof idOrSlugParam>;
      const tiers = await services.public
        .getEventTicketTiers(idOrSlug)
        .catch((error: unknown) => mapDomainError(reply, request, idOrSlug, error));
      if (!tiers) return reply;
      const validated = validateV2Response(
        reply,
        request,
        publicTierListSchema,
        tiers.map(publicTierToDto),
      );
      if (!validated) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/promoter-links/:handle/:slug',
    {
      preHandler: [
        fastify.rateLimit('PUBLIC_READ'),
        fastify.validateV2({ params: vanityParamsSchema }),
      ],
    },
    async (request, reply) => {
      const { handle, slug } = request.params as z.infer<typeof vanityParamsSchema>;
      const resolved = await services.referralLinks.resolveVanity(handle, slug);
      if (!resolved) return reply.status(404).send({ message: 'Link not found' });
      const validated = validateV2Response(reply, request, vanityResolutionSchema, resolved);
      if (!validated) return reply;
      return reply.send(validated);
    },
  );

  // Anonymous share-link hit tracking. Attribution itself is still resolved
  // from the signed server-side record during checkout.
  fastify.post(
    '/promoter-links/click',
    {
      preHandler: [
        fastify.rateLimit('PUBLIC_READ'),
        fastify.validateV2({ body: promoterClickBodySchema }),
      ],
    },
    async (request, reply) => {
      const { eventSlug, code } = request.body as z.infer<typeof promoterClickBodySchema>;
      const event = await services.public
        .getEvent(eventSlug)
        .catch((error: unknown) => mapDomainError(reply, request, eventSlug, error));
      if (!event) return reply;
      const link = await services.referralLinks.trackClick(event.id, code);
      return reply.send({ tracked: Boolean(link) });
    },
  );

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
      const event = await services.public
        .getEvent(idOrSlug)
        .catch((error: unknown) => mapDomainError(reply, request, idOrSlug, error));
      if (event === undefined) return reply;
      const validated = validateV2Response(reply, request, eventDtoSchema, eventToDto(event));
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
      const validated = validateV2Response(reply, request, venueDtoSchema, venueToDto(venue));
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
}

function publicTierToDto(tier: TicketTier) {
  return {
    id: tier.id,
    eventId: tier.eventId,
    organizationId: tier.organizationId,
    name: tier.name,
    description: tier.description,
    entryType: tier.entryType,
    currency: tier.currency,
    priceInPaise: tier.priceInPaise,
    quantity: tier.quantity,
    status: tier.status,
    salesStartAt: tier.salesStartAt,
    salesEndAt: tier.salesEndAt,
    maxPerOrder: tier.maxPerOrder,
    ...(tier.accessType ? { accessType: tier.accessType } : {}),
    ...(tier.audienceType ? { audienceType: tier.audienceType } : {}),
    ...(tier.guestCount ? { guestCount: tier.guestCount } : {}),
    ...(tier.pricingPhases ? { pricingPhases: tier.pricingPhases } : {}),
    ...(tier.doorPriceInPaise !== undefined ? { doorPriceInPaise: tier.doorPriceInPaise } : {}),
    ...(tier.benefits ? { benefits: tier.benefits } : {}),
    ...(tier.minAge !== undefined ? { minAge: tier.minAge } : {}),
    ...(tier.maxAge !== undefined ? { maxAge: tier.maxAge } : {}),
  };
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
