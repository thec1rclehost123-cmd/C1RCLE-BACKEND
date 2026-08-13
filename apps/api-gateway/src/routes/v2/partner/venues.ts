import { buildV2ErrorResponse } from '@c1rcle/contracts';
import {
  opaqueIdSchema,
  idempotencyKeySchema,
  paginationQuerySchema,
  venueDtoSchema,
  createVenueSchema,
  venueProfileDtoSchema,
  venueSlotDtoSchema,
  slotRequestDtoSchema,
  createSlotRequestSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { ActorContext } from '@c1rcle/core/application';
import type { Venue } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── V2 partners venues slice ────────────────────────────────────────────────
 * Thin routes (T16): validate → actor → `VenueService` → serialize to the
 * canonical `venueDtoSchema` (public-facing only — no contact/business fields).
 * Venues are org-scoped server-side; cross-tenant fetches 404 (IDOR guard).
 */

const services = createV2Services();

const venueIdParam = z.object({ venueId: opaqueIdSchema });
const orgIdParam = z.object({ organizationId: opaqueIdSchema });

const createVenueBody = createVenueSchema;

const venueHeaders = z.looseObject({
  'x-organization-id': opaqueIdSchema,
  'idempotency-key': idempotencyKeySchema.optional(),
});

const venueListSchema = paginatedSchema(venueDtoSchema);
const slotRequestListSchema = paginatedSchema(slotRequestDtoSchema);

const calendarQuery = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
});

const updateVenueHeaders = z.looseObject({
  'x-organization-id': opaqueIdSchema,
  'idempotency-key': idempotencyKeySchema,
  'if-match': z.string().regex(/^[1-9][0-9]*$/, 'If-Match must be a positive integer version'),
});

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

/**
 * Org-scoped path guard (T15): the `:organizationId` path param must match
 * the actor's resolved organization — mismatch is 403, never a cross-tenant
 * write/list. Returns `undefined` after sending.
 */
function requirePathOrg(
  reply: FastifyReply,
  request: FastifyRequest,
  actor: ActorContext,
  pathOrganizationId: string,
): undefined | true {
  if (actor.organizationId === pathOrganizationId) return true;
  reply.status(403).send(
    buildV2ErrorResponse({
      status: 403,
      message: 'Organization mismatch',
      code: 'forbidden',
      requestId: request.id,
    }),
  );
  return undefined;
}

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
      const { organizationId } = request.params as z.infer<typeof orgIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      if (requirePathOrg(reply, request, actor, organizationId) === undefined) return reply;
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
          total: page.total,
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
        headers: venueHeaders.extend({ 'idempotency-key': idempotencyKeySchema }),
      }),
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof orgIdParam>;
      const body = request.body as z.infer<typeof createVenueBody>;
      const actor = services.actor(request);
      if (requirePathOrg(reply, request, actor, organizationId) === undefined) return reply;
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'venue.create',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { organizationId }, body },
        run: async () => {
          const venue = await services.venues.create(actor, {
            name: body.name,
            slug: body.slug,
            description: body.description,
            capacity: body.capacity ?? null,
            city: body.city ?? null,
          });
          const validated = validateV2Response(reply, request, venueDtoSchema, venueToDto(venue));
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, 'new_venue', error, {
            conflictId: v2Headers['idempotency-key'],
          });
        }
        return mapDomainError(reply, request, 'new_venue', error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
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

  // ── UPDATE (PATCH, optimistic-locked + idempotent) ────────────────────────
  fastify.patch(
    '/venues/:venueId',
    {
      preHandler: fastify.validateV2({
        params: venueIdParam,
        headers: updateVenueHeaders,
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
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'venue.update',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { venueId }, body },
        run: async () => {
          const venue = await services.venues.update(actor, {
            venueId,
            expectedVersion,
            update: body,
          });
          const validated = validateV2Response(reply, request, venueDtoSchema, venueToDto(venue));
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, venueId, error, {
            conflictId: v2Headers['idempotency-key'],
          });
        }
        return mapDomainError(reply, request, venueId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── PROFILE (owner-scoped: public + private fields together) ─────────────
  // task.md §5 also lists `/venues/:venueId/menu` and `/venues/:venueId/
  // availability` — not registered: the domain model has no `menu` field on
  // `VenuePublicProfile` and no distinct "availability" computation beyond
  // the calendar's slot list yet (see docs/roadmap/phase-01-partner-dashboards.md).
  // Adding fake routes ahead of real domain support would violate rule 10
  // ("no mocks in shipped code").
  fastify.get(
    '/venues/:venueId/profile',
    { preHandler: fastify.validateV2({ params: venueIdParam, headers: venueHeaders }) },
    async (request, reply) => {
      const { venueId } = request.params as z.infer<typeof venueIdParam>;
      const actor = services.actor(request);
      const venue = await services.venues
        .get(actor, venueId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, venueId, error, { hideForbidden: true }),
        );
      if (venue === undefined) return reply;
      const validated = validateV2Response(reply, request, venueProfileDtoSchema, {
        public: venue.public,
        private: venue.private,
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.patch(
    '/venues/:venueId/profile',
    {
      preHandler: fastify.validateV2({
        params: venueIdParam,
        headers: updateVenueHeaders,
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
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'venue.profile.update',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { venueId }, body },
        run: async () => {
          const venue = await services.venues.update(actor, {
            venueId,
            expectedVersion,
            update: body,
          });
          const validated = validateV2Response(reply, request, venueProfileDtoSchema, {
            public: venue.public,
            private: venue.private,
          });
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, venueId, error, {
            conflictId: v2Headers['idempotency-key'],
          });
        }
        return mapDomainError(reply, request, venueId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── CALENDAR (read-only slot list) ────────────────────────────────────────
  fastify.get(
    '/venues/:venueId/calendar',
    {
      preHandler: fastify.validateV2({
        params: venueIdParam,
        querystring: calendarQuery,
        headers: venueHeaders,
      }),
    },
    async (request, reply) => {
      const { venueId } = request.params as z.infer<typeof venueIdParam>;
      const { from, to } = request.query as z.infer<typeof calendarQuery>;
      const actor = services.actor(request);
      const slots = await services.venueCalendar
        .getSlots(actor, venueId, from, to)
        .catch((error: unknown) =>
          mapDomainError(reply, request, venueId, error, { hideForbidden: true }),
        );
      if (slots === undefined) return reply;
      const validated = validateV2Response(reply, request, z.array(venueSlotDtoSchema), slots);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── SLOT REQUESTS (host-initiated create; venue-owner-scoped list/accept/reject) ──
  fastify.get(
    '/venues/:venueId/slot-requests',
    {
      preHandler: fastify.validateV2({
        params: venueIdParam,
        querystring: paginationQuerySchema,
        headers: venueHeaders,
      }),
    },
    async (request, reply) => {
      const { venueId } = request.params as z.infer<typeof venueIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.venueSlotRequests
        .listForVenue(actor, venueId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) =>
          mapDomainError(reply, request, venueId, error, { hideForbidden: true }),
        );
      if (page === undefined) return reply;
      const payload = {
        items: page.items,
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
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
      preHandler: fastify.validateV2({
        params: venueIdParam,
        body: createSlotRequestSchema,
        headers: venueHeaders.extend({ 'idempotency-key': idempotencyKeySchema }),
      }),
    },
    async (request, reply) => {
      const { venueId } = request.params as z.infer<typeof venueIdParam>;
      const body = request.body as z.infer<typeof createSlotRequestSchema>;
      // Cross-org by design: the caller's org is the requesting host, not the
      // venue's org (a venue-owner check here would be backwards).
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'venue.slotRequest.create',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { venueId }, body },
        run: async () => {
          const slotRequest = await services.venueSlotRequests.create(actor, {
            venueId,
            eventId: body.eventId ?? null,
            hostId: actor.organizationId,
            message: body.message,
          });
          const validated = validateV2Response(reply, request, slotRequestDtoSchema, slotRequest);
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, 'new_slot_request', error, {
            conflictId: v2Headers['idempotency-key'],
          });
        }
        return mapDomainError(reply, request, 'new_slot_request', error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  const slotRequestIdParam = z.object({ slotRequestId: opaqueIdSchema });

  for (const action of ['accept', 'reject'] as const) {
    fastify.post(
      `/venues/slot-requests/:slotRequestId/${action}`,
      {
        preHandler: fastify.validateV2({
          params: slotRequestIdParam,
          headers: venueHeaders.extend({ 'idempotency-key': idempotencyKeySchema }),
        }),
      },
      async (request, reply) => {
        const { slotRequestId } = request.params as z.infer<typeof slotRequestIdParam>;
        const actor = services.actor(request);
        const v2Headers = request.v2Headers ?? {};
        const result = await runIdempotent({
          idempotency: services.idempotency,
          request,
          actorId: actor.userId,
          commandName: `venue.slotRequest.${action}`,
          idempotencyKey: v2Headers['idempotency-key'],
          context: { path: { slotRequestId }, body: {} },
          run: async () => {
            const slotRequest = await services.venueSlotRequests[action](actor, slotRequestId);
            const validated = validateV2Response(reply, request, slotRequestDtoSchema, slotRequest);
            if (validated === undefined) throw new Error('v2 response validation failed');
            return { statusCode: 200, body: validated };
          },
        }).catch((error: unknown) => {
          if (isIdempotencyConflict(error)) {
            return mapDomainError(reply, request, slotRequestId, error, {
              conflictId: v2Headers['idempotency-key'],
            });
          }
          return mapDomainError(reply, request, slotRequestId, error);
        });
        if (result === undefined) return reply;
        return reply.status(result.statusCode).send(result.body);
      },
    );
  }
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
