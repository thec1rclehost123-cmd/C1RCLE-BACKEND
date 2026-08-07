import { buildV2ErrorResponse } from '@c1rcle/contracts';
import {
  opaqueIdSchema,
  idempotencyKeySchema,
  paginationQuerySchema,
  versionHeaderSchema,
  eventDtoSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Event } from '@c1rcle/core/domain';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── V2 partners events slice ────────────────────────────────────────────────
 * Thin routes (T16): validate → build actor → call `EventService` → serialize
 * to the canonical `eventDtoSchema`. No Firestore, no business logic here.
 * Persistence is behind the injected repository adapters (`@c1rcle/core/...`,
 * memory-backed until the Firestore V2 adapters land).
 */

const services = createV2Services();

const eventIdParam = z.object({ eventId: opaqueIdSchema });

const createEventBody = z
  .object({
    title: z.string().min(1).max(200),
    summary: z.string().max(1000).optional(),
    description: z.string().max(20000).optional(),
    venueId: opaqueIdSchema,
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime().nullable().optional(),
    tags: z.array(z.string().min(1).max(40)).max(50).optional(),
  })
  .strict();

const createEventHeaders = z.looseObject({
  'x-organization-id': opaqueIdSchema,
  'idempotency-key': idempotencyKeySchema.optional(),
  'if-match': versionHeaderSchema.optional(),
});

const eventListSchema = paginatedSchema(eventDtoSchema);

export default async function partnerEventRoutes(fastify: FastifyInstance) {
  // ── LIST ──────────────────────────────────────────────────────────────────
  fastify.get(
    '/events',
    {
      preHandler: fastify.validateV2({
        querystring: paginationQuerySchema,
        headers: createEventHeaders,
      }),
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.events.list(actor, {
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
      const items = page.items.map(eventToDto);
      const payload = {
        items,
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: items.length,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, eventListSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── GET ONE ───────────────────────────────────────────────────────────────
  fastify.get(
    '/events/:eventId',
    {
      preHandler: fastify.validateV2({
        params: eventIdParam,
        headers: createEventHeaders,
      }),
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const actor = services.actor(request);
      const event = await services.events.get(actor, eventId).catch((error: unknown) => {
        return mapDomainError(reply, request, eventId, error, { hideForbidden: true });
      });
      if (event === undefined) return reply;
      const validated = validateV2Response(reply, request, eventDtoSchema, eventToDto(event));
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── CREATE ────────────────────────────────────────────────────────────────
  fastify.post(
    '/events',
    {
      preHandler: fastify.validateV2({
        body: createEventBody,
        headers: createEventHeaders,
      }),
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createEventBody>;
      const actor = services.actor(request);
      const event = await services.events
        .create(actor, {
          venueId: body.venueId,
          title: body.title,
          summary: body.summary,
          description: body.description,
          startAt: body.startAt,
          endAt: body.endAt ?? null,
          tags: body.tags,
        })
        .catch((error: unknown) => mapDomainError(reply, request, 'new_event', error));
      if (event === undefined) return reply;
      const validated = validateV2Response(reply, request, eventDtoSchema, eventToDto(event));
      if (validated === undefined) return reply;
      return reply.status(201).send(validated);
    },
  );
}

/** Converts the core domain Event to the canonical wire DTO. */
export function eventToDto(event: Event) {
  return {
    id: event.id,
    organizationId: event.organizationId,
    venueId: event.venueId,
    title: event.title,
    summary: event.summary,
    description: event.description,
    imageUrl: event.imageUrl,
    startAt: event.startAt,
    endAt: event.endAt,
    status: event.status,
    isPublic: event.isPublic,
    tags: event.tags,
    startingPricePaise: event.startingPricePaise,
    isFree: event.isFree,
    cancellationReason: event.cancellationReason,
    version: event.version,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

/** Maps core domain errors to the V2 error envelope; returns `undefined` after sending. */
export function mapDomainError(
  reply: FastifyReply,
  request: FastifyRequest,
  resourceId: string,
  error: unknown,
  options: { hideForbidden?: boolean } = {},
): undefined {
  const known = error as { code?: string; message?: string };
  const notFoundCodes = new Set([
    'organization_not_found',
    'venue_not_found',
    'event_not_found',
    'slot_request_not_found',
  ]);
  if (known?.code && notFoundCodes.has(known.code)) {
    reply.status(404).send(
      buildV2ErrorResponse({
        status: 404,
        message: known.message ?? 'Not found',
        code: 'not_found',
        requestId: request.id,
      }),
    );
    return undefined;
  }
  if (known?.code === 'forbidden') {
    // Single-resource reads hide cross-tenant existence (IDOR guard): a
    // forbidden fetch is reported as 404, never as it being someone else's.
    const status = options.hideForbidden ? 404 : 403;
    const code = options.hideForbidden ? 'not_found' : 'forbidden';
    reply.status(status).send(
      buildV2ErrorResponse({
        status,
        message: options.hideForbidden ? 'Not found' : (known.message ?? 'Forbidden'),
        code,
        requestId: request.id,
      }),
    );
    return undefined;
  }
  if (known?.code === 'version_conflict') {
    reply.status(409).send(
      buildV2ErrorResponse({
        status: 409,
        message: known.message ?? 'Version conflict',
        code: 'conflict',
        requestId: request.id,
      }),
    );
    return undefined;
  }
  reply.status(500).send(
    buildV2ErrorResponse({
      status: 500,
      message: 'Internal server error',
      code: 'server',
      requestId: request.id,
    }),
  );
  return undefined;
}
