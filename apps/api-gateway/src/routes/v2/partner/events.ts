import { buildV2ErrorResponse } from '@c1rcle/contracts';
import {
  opaqueIdSchema,
  idempotencyKeySchema,
  versionHeaderSchema,
  paginationQuerySchema,
  eventDtoSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { ActorContext } from '@c1rcle/core/application';
import type { Event } from '@c1rcle/core/domain';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { getV2Services } from '../../../lib/v2-services.js';

import type { Permission } from '../../../plugins/rbac.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── V2 partners events slice ────────────────────────────────────────────────
 * Thin routes (T16): validate → build actor → call `EventService` → serialize
 * to the canonical `eventDtoSchema`. No Firestore, no business logic here.
 * Persistence is behind the injected repository adapters (`@c1rcle/core/...`,
 * memory-backed until the Firestore V2 adapters land).
 */

/**
 * Resolved per call, not captured at import time: a module-level binding would
 * freeze the first bundle and leave the auth plugin checking membership against
 * a different store than the routes write to.
 */
const services = () => getV2Services();

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

/** Read headers: no command safety applies to a GET. */
const eventHeaders = z.looseObject({
  'x-organization-id': opaqueIdSchema,
});

/** Write headers — manifest `events.create` is `idempotency: REQUIRED` (T09). */
const createEventHeaders = eventHeaders.extend({
  'idempotency-key': idempotencyKeySchema,
});

const eventListSchema = paginatedSchema(eventDtoSchema);

/** Preview surface: the event plus the visibility a guest would get. */
const eventPreviewSchema = z.object({ event: eventDtoSchema, isPublic: z.boolean() });

/** Action headers: idempotent by contract; If-Match added per action. */
const actionHeaders = eventHeaders.extend({ 'idempotency-key': idempotencyKeySchema });

const cancelBody = z.object({ reason: z.string().min(1).max(500).optional() }).strict();

export default async function partnerEventRoutes(fastify: FastifyInstance) {
  // ── LIST ──────────────────────────────────────────────────────────────────
  fastify.get(
    '/events',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.authenticate(),
        fastify.requirePermission('event.read'),
        fastify.validateV2({
          querystring: paginationQuerySchema,
          headers: eventHeaders,
        }),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services().actor(request);
      const page = await services().events.list(actor, {
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
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.authenticate(),
        fastify.requirePermission('event.read'),
        fastify.validateV2({
          params: eventIdParam,
          headers: eventHeaders,
        }),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const actor = services().actor(request);
      const event = await services()
        .events.get(actor, eventId)
        .catch((error: unknown) => {
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
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.authenticate(),
        fastify.requirePermission('event.create'),
        fastify.validateV2({
          body: createEventBody,
          headers: createEventHeaders,
        }),
        fastify.idempotent('events.create'),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createEventBody>;
      const actor = services().actor(request);
      const event = await services()
        .events.create(actor, {
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

  // ── PREVIEWS (what a guest would see) ─────────────────────────────────────
  fastify.get(
    '/events/:eventId/previews',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.authenticate(),
        fastify.requirePermission('event.read'),
        fastify.validateV2({ params: eventIdParam, headers: eventHeaders }),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const actor = services().actor(request);
      // Ownership first: previewing must not become a public read of a draft.
      const owned = await services()
        .events.get(actor, eventId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (owned === undefined) return reply;

      const payload = { event: eventToDto(owned), isPublic: owned.isPublic };
      const validated = validateV2Response(reply, request, eventPreviewSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── LIFECYCLE ACTIONS ─────────────────────────────────────────────────────
  // Every action is idempotent (T09) and version-locked (T10): a retried
  // publish produces one published event, and a stale client cannot move an
  // event someone else already advanced.
  registerAction(fastify, 'review', 'event.update', (actor, eventId) =>
    services().events.review(actor, eventId),
  );
  registerAction(fastify, 'publish', 'event.publish', (actor, eventId) =>
    services().events.publish(actor, eventId),
  );
  registerAction(fastify, 'pause-sales', 'event.update', (actor, eventId) =>
    services().events.pauseSales(actor, eventId),
  );
  registerAction(fastify, 'resume-sales', 'event.update', (actor, eventId) =>
    services().events.resumeSales(actor, eventId),
  );
  registerAction(
    fastify,
    'cancel',
    'event.cancel',
    (actor, eventId, body) =>
      services().events.cancel(actor, eventId, body.reason ?? 'Cancelled by the organizer'),
    cancelBody,
  );
  registerAction(
    fastify,
    'duplicate',
    'event.create',
    (actor, eventId) => services().events.duplicate(actor, eventId),
    undefined,
    // A duplicate creates a NEW event, so there is no version to match on.
    { requireVersion: false, successStatus: 201 },
  );
}

/** POST /events/:eventId/<action> — one shape for every lifecycle command. */
function registerAction(
  fastify: FastifyInstance,
  action: string,
  permission: Permission,
  run: (actor: ActorContext, eventId: string, body: { reason?: string }) => Promise<Event>,
  bodySchema?: z.ZodType,
  options: { requireVersion?: boolean; successStatus?: number } = {},
): void {
  const requireVersion = options.requireVersion ?? true;
  const headers = requireVersion
    ? actionHeaders.extend({ 'if-match': versionHeaderSchema })
    : actionHeaders;

  fastify.post(
    `/events/:eventId/${action}`,
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.authenticate(),
        fastify.requirePermission(permission),
        fastify.validateV2({ params: eventIdParam, headers, body: bodySchema }),
        fastify.idempotent(`events.${action}`),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const actor = services().actor(request);
      const body = (request.body ?? {}) as { reason?: string };

      if (requireVersion) {
        const expected = Number.parseInt(request.v2Headers?.['if-match'] ?? '', 10);
        const current = await services()
          .events.get(actor, eventId)
          .catch((error: unknown) => mapDomainError(reply, request, eventId, error));
        if (current === undefined) return reply;
        if (current.version !== expected) {
          reply.status(409).send(
            buildV2ErrorResponse({
              status: 409,
              code: 'conflict',
              message: `Version conflict: expected ${expected}, current ${current.version}`,
              requestId: request.id,
              details: { expectedVersion: expected, currentVersion: current.version },
            }),
          );
          return reply;
        }
      }

      const updated = await run(actor, eventId, body).catch((error: unknown) =>
        mapDomainError(reply, request, eventId, error),
      );
      if (updated === undefined) return reply;

      const validated = validateV2Response(reply, request, eventDtoSchema, eventToDto(updated));
      if (validated === undefined) return reply;
      return reply.status(options.successStatus ?? 200).send(validated);
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
    // T10: the client must be able to refetch and retry, so the conflict
    // carries the version it sent and the version that actually won.
    const conflict = error as { expectedVersion?: number; currentVersion?: number };
    reply.status(409).send(
      buildV2ErrorResponse({
        status: 409,
        message: known.message ?? 'Version conflict',
        code: 'conflict',
        requestId: request.id,
        details: {
          expectedVersion: conflict.expectedVersion,
          currentVersion: conflict.currentVersion,
        },
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
