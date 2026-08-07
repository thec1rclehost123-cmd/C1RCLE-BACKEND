import {
  opaqueIdSchema,
  idempotencyKeySchema,
  paginationQuerySchema,
  venueDtoSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Venue } from '@c1rcle/core/domain';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 partners venues slice ────────────────────────────────────────────────
 * Thin routes (T16): validate → actor → `VenueService` → serialize to the
 * canonical `venueDtoSchema` (public-facing only — no contact/business fields).
 * Venues are org-scoped server-side; cross-tenant fetches 404 (IDOR guard).
 */

const services = createV2Services();

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

const venueHeaders = z.looseObject({
  'x-organization-id': opaqueIdSchema,
  'idempotency-key': idempotencyKeySchema.optional(),
  'if-match': z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .optional(),
});

const venueListSchema = paginatedSchema(venueDtoSchema);

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
      preHandler: fastify.validateV2({
        params: orgIdParam,
        querystring: paginationQuerySchema,
        headers: venueHeaders,
      }),
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.venues.list(actor, {
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
      preHandler: fastify.validateV2({
        params: orgIdParam,
        body: createVenueBody,
        headers: venueHeaders,
      }),
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createVenueBody>;
      const actor = services.actor(request);
      const venue = await services.venues.create(actor, { name: body.name, slug: body.slug });
      const validated = validateV2Response(reply, request, venueDtoSchema, venueToDto(venue));
      if (validated === undefined) return reply;
      return reply.status(201).send(validated);
    },
  );

  // ── GET ONE (tenant-guarded: cross-org fetch → 404) ───────────────────────
  fastify.get(
    '/venues/:venueId',
    {
      preHandler: fastify.validateV2({ params: venueIdParam, headers: venueHeaders }),
    },
    async (request, reply) => {
      const { venueId } = request.params as z.infer<typeof venueIdParam>;
      const actor = services.actor(request);
      const venue = await services.venues
        .get(actor, venueId)
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
      preHandler: fastify.validateV2({
        params: venueIdParam,
        headers: venueHeaders,
        body: updateVenueBody,
      }),
    },
    async (request, reply) => {
      const { venueId } = request.params as z.infer<typeof venueIdParam>;
      const body = request.body as z.infer<typeof updateVenueBody>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const expectedVersion = v2Headers['if-match']
        ? Number.parseInt(v2Headers['if-match'], 10)
        : null;
      const venue = await services.venues
        .update(actor, { venueId, expectedVersion, update: body })
        .catch((error: unknown) => mapDomainError(reply, request, venueId, error));
      if (venue === undefined) return reply;
      const validated = validateV2Response(reply, request, venueDtoSchema, venueToDto(venue));
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
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
