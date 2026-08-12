import {
  opaqueIdSchema,
  idempotencyKeySchema,
  versionHeaderSchema,
  paginationQuerySchema,
  venueDtoSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { SlotRequest, Venue } from '@c1rcle/core/domain';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { getV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 partners venues slice ────────────────────────────────────────────────
 * Thin routes (T16): validate → actor → `VenueService` → serialize to the
 * canonical `venueDtoSchema` (public-facing only — no contact/business fields).
 * Venues are org-scoped server-side; cross-tenant fetches 404 (IDOR guard).
 */

/**
 * Resolved per call, not captured at import time: a module-level binding would
 * freeze the first bundle and leave the auth plugin checking membership against
 * a different store than the routes write to.
 */
const services = () => getV2Services();

const venueIdParam = z.object({ venueId: opaqueIdSchema });
const orgIdParam = z.object({ organizationId: opaqueIdSchema });

const createVenueBody = z
  .object({
    name: z.string().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid slug format'),
  })
  .strict();

/** Read headers: no command safety applies to a GET. */
const venueHeaders = z.looseObject({
  'x-organization-id': opaqueIdSchema,
});

/**
 * Write headers — manifest `idempotency: REQUIRED` on venue commands (T09) and
 * `expectedVersion: REQUIRED` on `venues.update` (T10). Both are mandatory, so
 * an unprotected write is a 422 rather than a silent lost update.
 */
const venueCommandHeaders = venueHeaders.extend({
  'idempotency-key': idempotencyKeySchema,
});

const venueUpdateHeaders = venueCommandHeaders.extend({
  'if-match': versionHeaderSchema,
});

const venueListSchema = paginatedSchema(venueDtoSchema);

/** The guest-facing half of a venue. Contact fields are structurally absent. */
const venueProfileSchema = z.object({
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  shortDescription: z.string().nullable(),
  capacity: z.number().int().nonnegative().nullable(),
  facilities: z.array(z.string()),
  city: z.string().nullable(),
});

const slotRequestDtoSchema = z.object({
  id: opaqueIdSchema,
  venueId: opaqueIdSchema,
  eventId: opaqueIdSchema.nullable(),
  hostId: opaqueIdSchema,
  status: z.enum(['pending', 'accepted', 'rejected', 'cancelled']),
  message: z.string().nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const slotRequestListSchema = paginatedSchema(slotRequestDtoSchema);

const createSlotRequestBody = z
  .object({
    eventId: opaqueIdSchema.nullable().optional(),
    message: z.string().max(1000).optional(),
  })
  .strict();

const updateVenueBody = z
  .object({
    public: z
      .object({
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional(),
        shortDescription: z.string().max(200).optional(),
        facilities: z.array(z.string().min(1).max(60)).max(50).optional(),
        capacity: z.number().int().nonnegative().nullable().optional(),
      })
      .optional(),
    private: z
      .object({
        contactEmail: z.email().nullable().optional(),
        contactPhone: z.string().max(20).nullable().optional(),
      })
      .optional(),
  })
  .strict();

export default async function partnerVenueRoutes(fastify: FastifyInstance) {
  // ── LIST (org-scoped) ─────────────────────────────────────────────────────
  fastify.get(
    '/organizations/:organizationId/venues',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.authenticate(),
        fastify.requirePermission('venue.read'),
        fastify.validateV2({
          params: orgIdParam,
          querystring: paginationQuerySchema,
          headers: venueHeaders,
        }),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services().actor(request);
      const page = await services().venues.list(actor, {
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
      const items = page.items.map(venueToDto);
      const payload = {
        items,
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: items.length,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, venueListSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── CREATE (org-scoped) ───────────────────────────────────────────────────
  fastify.post(
    '/organizations/:organizationId/venues',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.authenticate(),
        fastify.requirePermission('venue.create'),
        fastify.validateV2({
          params: orgIdParam,
          body: createVenueBody,
          headers: venueCommandHeaders,
        }),
        fastify.idempotent('venues.create'),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createVenueBody>;
      const actor = services().actor(request);
      const venue = await services().venues.create(actor, { name: body.name, slug: body.slug });
      const validated = validateV2Response(reply, request, venueDtoSchema, venueToDto(venue));
      if (validated === undefined) return reply;
      return reply.status(201).send(validated);
    },
  );

  // ── GET ONE (tenant-guarded: cross-org fetch → 404) ───────────────────────
  fastify.get(
    '/venues/:venueId',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.authenticate(),
        fastify.requirePermission('venue.read'),
        fastify.validateV2({ params: venueIdParam, headers: venueHeaders }),
      ],
    },
    async (request, reply) => {
      const { venueId } = request.params as z.infer<typeof venueIdParam>;
      const actor = services().actor(request);
      const venue = await services()
        .venues.get(actor, venueId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, venueId, error, { hideForbidden: true }),
        );
      if (venue === undefined) return reply;
      const validated = validateV2Response(reply, request, venueDtoSchema, venueToDto(venue));
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── UPDATE (PATCH, optimistic-locked via If-Match) ────────────────────────
  fastify.patch(
    '/venues/:venueId',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.authenticate(),
        fastify.requirePermission('venue.manage'),
        fastify.validateV2({
          params: venueIdParam,
          headers: venueUpdateHeaders,
          body: updateVenueBody,
        }),
        fastify.idempotent('venues.update'),
      ],
    },
    async (request, reply) => {
      const { venueId } = request.params as z.infer<typeof venueIdParam>;
      const body = request.body as z.infer<typeof updateVenueBody>;
      const actor = services().actor(request);
      const v2Headers = request.v2Headers ?? {};
      const expectedVersion = v2Headers['if-match']
        ? Number.parseInt(v2Headers['if-match'], 10)
        : null;
      const venue = await services()
        .venues.update(actor, { venueId, expectedVersion, update: body })
        .catch((error: unknown) => mapDomainError(reply, request, venueId, error));
      if (venue === undefined) return reply;
      const validated = validateV2Response(reply, request, venueDtoSchema, venueToDto(venue));
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── PUBLIC PROFILE (guest-facing projection) ──────────────────────────────
  fastify.get(
    '/venues/:venueId/profile',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.authenticate(),
        fastify.requirePermission('venue.read'),
        fastify.cached('VENUE_PROFILE'),
        fastify.validateV2({ params: venueIdParam, headers: venueHeaders }),
      ],
    },
    async (request, reply) => {
      const { venueId } = request.params as z.infer<typeof venueIdParam>;
      const actor = services().actor(request);
      const profile = await services()
        .venues.getPublicProfile(actor, venueId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, venueId, error, { hideForbidden: true }),
        );
      if (profile === undefined) return reply;

      // Only the public half is serialized — contact details cannot leak here.
      const payload = {
        name: profile.name,
        slug: profile.slug,
        description: profile.description,
        shortDescription: profile.shortDescription ?? null,
        capacity: profile.capacity,
        facilities: [...(profile.facilities ?? [])],
        city: profile.address?.city ?? null,
      };
      const validated = validateV2Response(reply, request, venueProfileSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── SLOT REQUESTS ─────────────────────────────────────────────────────────
  fastify.get(
    '/venues/:venueId/slot-requests',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.authenticate(),
        fastify.requirePermission('venue.read'),
        fastify.validateV2({
          params: venueIdParam,
          querystring: paginationQuerySchema,
          headers: venueHeaders,
        }),
      ],
    },
    async (request, reply) => {
      const { venueId } = request.params as z.infer<typeof venueIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services().actor(request);
      const page = await services()
        .slotRequests.listForVenue(actor, venueId, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        })
        .catch((error: unknown) =>
          mapDomainError(reply, request, venueId, error, { hideForbidden: true }),
        );
      if (page === undefined) return reply;

      const payload = {
        items: page.items.map(slotRequestToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.items.length,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, slotRequestListSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/venues/:venueId/slot-requests',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.authenticate(),
        fastify.requirePermission('event.create'),
        fastify.validateV2({
          params: venueIdParam,
          headers: venueCommandHeaders,
          body: createSlotRequestBody,
        }),
        fastify.idempotent('venue-slot-requests.create'),
      ],
    },
    async (request, reply) => {
      const { venueId } = request.params as z.infer<typeof venueIdParam>;
      const body = request.body as z.infer<typeof createSlotRequestBody>;
      const actor = services().actor(request);
      const created = await services()
        .slotRequests.create(actor, {
          venueId,
          eventId: body.eventId ?? null,
          // The host is the caller: never trust a client-supplied identity.
          hostId: actor.userId,
          message: body.message,
        })
        .catch((error: unknown) => mapDomainError(reply, request, venueId, error));
      if (created === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        slotRequestDtoSchema,
        slotRequestToDto(created),
      );
      if (validated === undefined) return reply;
      return reply.status(201).send(validated);
    },
  );
}

function slotRequestToDto(request: SlotRequest) {
  return {
    id: request.id,
    venueId: request.venueId,
    eventId: request.eventId,
    hostId: request.hostId,
    status: request.status,
    message: request.message ?? null,
    version: request.version,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

/** Converts the core domain Venue to the canonical public-facing wire DTO. */
export function venueToDto(venue: Venue) {
  return {
    id: venue.id,
    organizationId: venue.organizationId,
    name: venue.public.name,
    slug: venue.public.slug,
    status: venue.status,
    description: venue.public.description,
    capacity: venue.public.capacity,
    city: venue.public.address?.city ?? null,
    version: venue.version,
    createdAt: venue.createdAt,
    updatedAt: venue.updatedAt,
  };
}
