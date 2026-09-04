import {
  paginationQuerySchema,
  eventDtoSchema,
  venueDtoSchema,
  hostPublicDtoSchema,
  discoveryFeedDtoSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Organization } from '@c1rcle/core/domain';

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

/** Public-safe host DTO: no `role` (that's the caller's membership, and
 * there is no caller here), no settings, no member list. */
function hostToDto(org: Organization) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
  };
}
