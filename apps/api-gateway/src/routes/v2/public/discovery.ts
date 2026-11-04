import {
  paginationQuerySchema,
  eventDtoSchema,
  eventPublicDetailDtoSchema,
  venueDtoSchema,
  venuePublicDetailDtoSchema,
  hostPublicDtoSchema,
  discoveryFeedDtoSchema,
  publicTicketTierListResponseSchema,
  publicTicketAddonListResponseSchema,
  paginatedSchema,
  redeemTicketAccessCodeSchema,
  ticketAccessGrantDtoSchema,
} from '@c1rcle/contracts/client';
import { UnauthorizedError, effectiveTierPricePaise } from '@c1rcle/core/domain';
import { z } from 'zod';

import type { Organization, TicketTier, Venue } from '@c1rcle/core/domain';

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
const publicTierHeadersSchema = z.looseObject({
  'x-ticket-access-grant-id': z.string().min(1).max(64).optional(),
});

function optionalActorUserId(request: Parameters<typeof services.actor>[0]): string | undefined {
  try {
    return services.actor(request).userId ?? undefined;
  } catch (error) {
    // Public reads accept anonymous callers. On the Firestore driver, the
    // strict actor resolver correctly rejects a missing session; for these
    // reads, treat only that expected unauthenticated case as anonymous.
    if (error instanceof UnauthorizedError) return undefined;
    throw error;
  }
}

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
const promoterClickBodySchema = z
  .object({
    eventSlug: z.string().min(1).max(80),
    code: z.string().min(4).max(16),
    clickId: z.uuid(),
  })
  .strict();
const vanityParamsSchema = z.object({
  handle: z.string().min(1).max(60),
  slug: z.string().min(1).max(60),
});
const vanityResolutionSchema = z.object({ eventSlug: z.string(), code: z.string() });

export default async function publicDiscoveryRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/ticket-access-codes/redeem',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ body: redeemTicketAccessCodeSchema }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const actor = services.actor(request);
      if (!actor.userId) {
        mapDomainError(
          reply,
          request,
          'ticket-access-codes/redeem',
          new UnauthorizedError('Authentication is required to redeem an access code'),
        );
        return reply;
      }
      const { code } = request.body as z.infer<typeof redeemTicketAccessCodeSchema>;
      const grant = await services.ticketAccess
        .redeemCode(actor, code)
        .catch((error: unknown) =>
          mapDomainError(reply, request, 'ticket-access-codes/redeem', error),
        );
      if (!grant) return reply;
      const validated = validateV2Response(reply, request, ticketAccessGrantDtoSchema, {
        id: grant.id,
        eventId: grant.eventId,
        scope: grant.scope ?? 'tiers',
        tierIds: grant.tierIds,
        expiresAt: grant.expiresAt,
      });
      if (validated === undefined) return reply;
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
      const { eventSlug, code, clickId } = request.body as z.infer<typeof promoterClickBodySchema>;
      const detail = await services.public
        .getEvent(eventSlug)
        .catch((error: unknown) => mapDomainError(reply, request, eventSlug, error));
      if (!detail) return reply;
      // Keep code validity private. The service records a click only when the
      // code is valid, while the anonymous response stays identical either way.
      await services.referralLinks.trackClick(detail.event.id, code, clickId);
      return reply.send({ accepted: true });
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
      reply.header('cache-control', 'private, no-store');
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
      preHandler: [
        fastify.rateLimit('PUBLIC_READ'),
        fastify.validateV2({ params: idOrSlugParam, headers: publicTierHeadersSchema }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { idOrSlug } = request.params as z.infer<typeof idOrSlugParam>;
      const rawGrantId = request.headers['x-ticket-access-grant-id'];
      const accessGrantId = Array.isArray(rawGrantId) ? rawGrantId[0] : rawGrantId;
      const userId = optionalActorUserId(request);
      const detail = await services.public
        .getEvent(idOrSlug, userId, accessGrantId)
        .catch((error: unknown) => mapDomainError(reply, request, idOrSlug, error));
      if (detail === undefined) return reply;
      const privateEvent =
        detail.event.visibilityMode === 'code' || detail.event.visibilityMode === 'invited';
      const payload = {
        ...eventToDto(detail.event),
        // PublicService emits only a short-lived signed URL for an event grant;
        // partner and anonymous projections always redact private poster URLs.
        imageUrl: detail.event.imageUrl,
        venue:
          detail.venue === null
            ? null
            : eventVenueToDto(detail.venue, {
                revealAddress:
                  (detail.event.addressDisclosure ?? (privateEvent ? 'hidden' : 'public')) ===
                    'public' ||
                  (privateEvent && detail.event.addressDisclosure === 'after_grant'),
                hideAddress:
                  (detail.event.addressDisclosure ?? (privateEvent ? 'hidden' : 'public')) ===
                  'hidden',
              }),
        organizer: detail.organizer === null ? null : hostToDto(detail.organizer),
      };
      const validated = validateV2Response(reply, request, eventPublicDetailDtoSchema, payload);
      if (validated === undefined) return reply;
      if (privateEvent) {
        reply.header('cache-control', 'private, no-store');
        reply.header('x-robots-tag', 'noindex, nofollow, noarchive');
      }
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
      reply.header('cache-control', 'private, no-store');
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
      reply.header('cache-control', 'private, no-store');
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
      preHandler: [
        fastify.rateLimit('PUBLIC_READ'),
        fastify.validateV2({ params: idOrSlugParam, headers: publicTierHeadersSchema }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { idOrSlug } = request.params as z.infer<typeof idOrSlugParam>;
      const rawGrantId = request.headers['x-ticket-access-grant-id'];
      const accessGrantId = Array.isArray(rawGrantId) ? rawGrantId[0] : rawGrantId;
      const userId = optionalActorUserId(request);
      const rows = await services.public
        .listEventTiers(idOrSlug, userId, accessGrantId)
        .catch((error: unknown) => mapDomainError(reply, request, idOrSlug, error));
      if (rows === undefined) return reply;
      const detail = await services.public
        .getEvent(idOrSlug, userId, accessGrantId)
        .catch((error: unknown) => mapDomainError(reply, request, idOrSlug, error));
      if (!detail) return reply;
      if (detail.event.visibilityMode === 'code' || detail.event.visibilityMode === 'invited') {
        reply.header('cache-control', 'private, no-store');
        reply.header('x-robots-tag', 'noindex, nofollow, noarchive');
      }
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

  fastify.get(
    '/events/:idOrSlug/ticket-addons',
    {
      preHandler: [
        fastify.rateLimit('PUBLIC_READ'),
        fastify.validateV2({ params: idOrSlugParam, headers: publicTierHeadersSchema }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { idOrSlug } = request.params as z.infer<typeof idOrSlugParam>;
      const rawGrantId = request.headers['x-ticket-access-grant-id'];
      const accessGrantId = Array.isArray(rawGrantId) ? rawGrantId[0] : rawGrantId;
      const userId = optionalActorUserId(request);
      const rows = await services.public
        .listEventTicketAddons(idOrSlug, userId, accessGrantId)
        .catch((error: unknown) => mapDomainError(reply, request, idOrSlug, error));
      if (rows === undefined) return reply;
      const detail = await services.public
        .getEvent(idOrSlug, userId, accessGrantId)
        .catch((error: unknown) => mapDomainError(reply, request, idOrSlug, error));
      if (!detail) return reply;
      if (detail.event.visibilityMode === 'code' || detail.event.visibilityMode === 'invited') {
        reply.header('x-robots-tag', 'noindex, nofollow, noarchive');
      }
      const payload = {
        items: rows.map(({ addon, availableQuantity }) => ({
          id: addon.id,
          eventId: addon.eventId,
          name: addon.name,
          description: addon.description,
          kind: addon.kind,
          priceInPaise: addon.priceInPaise,
          currency: addon.currency,
          availableQuantity,
          maxPerEntitlement: addon.maxPerEntitlement,
        })),
      };
      const validated = validateV2Response(
        reply,
        request,
        publicTicketAddonListResponseSchema,
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
 * Small event-location projection for the event-detail `venue` field: just
 * enough to identify and describe the authoritative venue, never its tenant
 * or private profile.
 */
function eventVenueToDto(
  venue: Venue,
  addressPolicy: { revealAddress: boolean; hideAddress: boolean } = {
    revealAddress: true,
    hideAddress: false,
  },
) {
  return {
    id: venue.id,
    name: venue.public.name,
    slug: venue.public.slug,
    photoUrl: venue.public.photoUrl,
    address: addressPolicy.revealAddress
      ? venue.public.address
      : addressPolicy.hideAddress
        ? {}
        : {
            city: venue.public.address.city,
            state: venue.public.address.state,
            country: venue.public.address.country,
          },
  };
}

/**
 * Full public venue detail: the canonical venue fields plus the explicitly
 * public profile fields. Owner/contact/internal-note data never leaves the
 * private profile.
 */
function publicVenueToDto(venue: Venue) {
  return {
    ...venueToDto(venue),
    photoUrl: venue.public.photoUrl,
    address: venue.public.address,
    facilities: venue.public.facilities,
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
    coverAmountPaise: tier.coverAmountPaise ?? 0,
    currency: tier.currency,
    availableQuantity,
    guestCount: tier.guestCount ?? 1,
    admissionMode: tier.admissionMode ?? 'bundle',
    audienceType: tier.audienceType ?? 'GENERAL',
    minAge: tier.minAge ?? null,
    maxAge: tier.maxAge ?? null,
  };
}
