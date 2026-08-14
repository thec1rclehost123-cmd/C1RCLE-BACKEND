import { buildV2ErrorResponse } from '@c1rcle/contracts';
import {
  opaqueIdSchema,
  idempotencyKeySchema,
  paginationQuerySchema,
  versionHeaderSchema,
  eventDtoSchema,
  updateEventSchema,
  cancelEventSchema,
  eventPreviewDtoSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { ActorContext } from '@c1rcle/core/application';
import type { Event } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import type { Permission } from '../../../plugins/rbac.js';
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
const orgIdParam = z.object({ organizationId: opaqueIdSchema });

/** Org-scoped path guard (T15) — mirrors `partner/venues.ts`'s `requirePathOrg`. */
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

const createEventBody = z
  .object({
    title: z.string().min(1).max(200),
    summary: z.string().max(1000).optional(),
    description: z.string().max(20000).optional(),
    imageUrl: z.url().nullable().optional(),
    venueId: opaqueIdSchema,
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime().nullable().optional(),
    tags: z.array(z.string().min(1).max(40)).max(50).optional(),
  })
  .strict();

const createEventHeaders = z.looseObject({
  'x-organization-id': opaqueIdSchema,
  'idempotency-key': idempotencyKeySchema,
  'if-match': versionHeaderSchema.optional(),
});

/** Read routes: no write-concurrency headers expected. */
const readHeaders = z.looseObject({
  'x-organization-id': opaqueIdSchema,
});

const eventListSchema = paginatedSchema(eventDtoSchema);

export default async function partnerEventRoutes(fastify: FastifyInstance) {
  // ── LIST (org-scoped path, matches task.md §5) ────────────────────────────
  fastify.get(
    '/organizations/:organizationId/events',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: orgIdParam,
          querystring: paginationQuerySchema,
          headers: readHeaders,
        }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof orgIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      if (requirePathOrg(reply, request, actor, organizationId) === undefined) return reply;
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
          total: page.total,
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
        fastify.validateV2({
          params: eventIdParam,
          headers: readHeaders,
        }),
        fastify.requirePermission('event.read'),
      ],
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

  // ── CREATE (org-scoped path, matches task.md §5) ──────────────────────────
  fastify.post(
    '/organizations/:organizationId/events',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: orgIdParam,
          body: createEventBody,
          headers: createEventHeaders,
        }),
        fastify.requirePermission('event.create'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof orgIdParam>;
      const body = request.body as z.infer<typeof createEventBody>;
      const actor = services.actor(request);
      if (requirePathOrg(reply, request, actor, organizationId) === undefined) return reply;
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'event.create',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: {}, body },
        run: async () => {
          const event = await services.events.create(actor, {
            venueId: body.venueId,
            title: body.title,
            summary: body.summary,
            description: body.description,
            imageUrl: body.imageUrl ?? null,
            startAt: body.startAt,
            endAt: body.endAt ?? null,
            tags: body.tags,
          });
          const validated = validateV2Response(reply, request, eventDtoSchema, eventToDto(event));
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error))
          return mapDomainError(reply, request, 'new_event', error, {
            conflictId: v2Headers['idempotency-key'],
          });
        return mapDomainError(reply, request, 'new_event', error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── UPDATE ────────────────────────────────────────────────────────────────
  fastify.patch(
    '/events/:eventId',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: eventIdParam,
          body: updateEventSchema,
          headers: createEventHeaders.extend({ 'if-match': versionHeaderSchema }),
        }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const body = request.body as z.infer<typeof updateEventSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const expectedVersion = v2Headers['if-match']
        ? Number.parseInt(v2Headers['if-match'], 10)
        : null;
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'event.update',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { eventId }, body },
        run: async () => {
          const event = await services.events.update(actor, {
            eventId,
            expectedVersion,
            changes: body,
          });
          const validated = validateV2Response(reply, request, eventDtoSchema, eventToDto(event));
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, eventId, error, {
            conflictId: v2Headers['idempotency-key'],
          });
        }
        return mapDomainError(reply, request, eventId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── PREVIEWS ──────────────────────────────────────────────────────────────
  fastify.get(
    '/events/:eventId/previews',
    { preHandler: fastify.validateV2({ params: eventIdParam }) },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const preview = await services.events
        .getPreview(eventId)
        .catch((error: unknown) => mapDomainError(reply, request, eventId, error));
      if (preview === undefined) return reply;
      const validated = validateV2Response(reply, request, eventPreviewDtoSchema, {
        event: eventToDto(preview.event),
        isPublic: preview.isPublic,
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── LIFECYCLE ACTIONS (idempotent + If-Match; each maps 1:1 to an
  // `EventService` method — the FSM validation lives in the domain model,
  // never here) ──────────────────────────────────────────────────────────────
  /**
   * Each lifecycle action carries its own authority: publishing is a
   * different decision from pausing sales, and duplicating creates a new
   * event rather than mutating this one.
   */
  const actionPermission = (action: string): Permission => {
    switch (action) {
      case 'publish':
        return 'event.publish';
      case 'duplicate':
        return 'event.create';
      default:
        return 'event.update';
    }
  };

  const simpleActions: Record<string, (actor: ActorContext, eventId: string) => Promise<Event>> = {
    review: (actor, eventId) => services.events.review(actor, eventId),
    publish: (actor, eventId) => services.events.publish(actor, eventId),
    'pause-sales': (actor, eventId) => services.events.pauseSales(actor, eventId),
    'resume-sales': (actor, eventId) => services.events.resumeSales(actor, eventId),
    duplicate: (actor, eventId) => services.events.duplicate(actor, eventId),
  };

  for (const [action, run] of Object.entries(simpleActions)) {
    fastify.post(
      `/events/:eventId/${action}`,
      {
        preHandler: [
          fastify.rateLimit('STANDARD_COMMAND'),
          fastify.validateV2({
            params: eventIdParam,
            headers: createEventHeaders,
          }),
          fastify.requirePermission(actionPermission(action)),
        ],
      },
      async (request, reply) => {
        const { eventId } = request.params as z.infer<typeof eventIdParam>;
        const actor = services.actor(request);
        const v2Headers = request.v2Headers ?? {};
        const result = await runIdempotent({
          idempotency: services.idempotency,
          request,
          actorId: actor.userId,
          commandName: `event.${action}`,
          idempotencyKey: v2Headers['idempotency-key'],
          context: { path: { eventId }, body: {} },
          run: async () => {
            const event = await run(actor, eventId);
            const statusCode = action === 'duplicate' ? 201 : 200;
            const validated = validateV2Response(reply, request, eventDtoSchema, eventToDto(event));
            if (validated === undefined) throw new Error('v2 response validation failed');
            return { statusCode, body: validated };
          },
        }).catch((error: unknown) => {
          if (isIdempotencyConflict(error)) {
            return mapDomainError(reply, request, eventId, error, {
              conflictId: v2Headers['idempotency-key'],
            });
          }
          return mapDomainError(reply, request, eventId, error);
        });
        if (result === undefined) return reply;
        return reply.status(result.statusCode).send(result.body);
      },
    );
  }

  // `cancel` needs a body (`reason`), so it's not folded into `simpleActions`.
  fastify.post(
    '/events/:eventId/cancel',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: eventIdParam,
          body: cancelEventSchema,
          headers: createEventHeaders,
        }),
        fastify.requirePermission('event.cancel'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const body = request.body as z.infer<typeof cancelEventSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'event.cancel',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { eventId }, body },
        run: async () => {
          const event = await services.events.cancel(actor, eventId, body.reason);
          const validated = validateV2Response(reply, request, eventDtoSchema, eventToDto(event));
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, eventId, error, {
            conflictId: v2Headers['idempotency-key'],
          });
        }
        return mapDomainError(reply, request, eventId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}

/** Converts the core domain Event to the canonical wire DTO. */
export function eventToDto(event: Event) {
  return {
    id: event.id,
    organizationId: event.organizationId,
    venueId: event.venueId,
    slug: event.slug,
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
  options: { hideForbidden?: boolean; conflictId?: string } = {},
): undefined {
  const known = error as {
    code?: string;
    message?: string;
    expectedVersion?: number;
    currentVersion?: number;
  };
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
        details: {
          expectedVersion: known.expectedVersion,
          currentVersion: known.currentVersion,
        },
      }),
    );
    return undefined;
  }
  if (known?.code === 'idempotency_conflict' || known?.code === 'idempotency_in_flight') {
    reply.status(409).send(
      buildV2ErrorResponse({
        status: 409,
        message: known.message ?? 'Idempotency conflict',
        code: 'conflict',
        requestId: request.id,
        details: { idempotencyKey: options.conflictId },
      }),
    );
    return undefined;
  }
  // Illegal FSM transition (e.g. publish from 'review' — needs 'scheduled'
  // first). Mirrors `plugins/error-handler.ts`'s global mapping; this
  // route-level catch runs first for handled requests, so it needs its own
  // copy of the same mapping rather than falling through to the generic 500.
  if (known?.code === 'state_transition') {
    reply.status(409).send(
      buildV2ErrorResponse({
        status: 409,
        message: known.message ?? 'Illegal state transition',
        code: 'conflict',
        requestId: request.id,
      }),
    );
    return undefined;
  }
  if (known?.code === 'invalid_operation') {
    reply.status(400).send(
      buildV2ErrorResponse({
        status: 400,
        message: known.message ?? 'Invalid operation',
        code: 'validation',
        requestId: request.id,
      }),
    );
    return undefined;
  }
  // Anything else is a genuine bug — log it (the pre-existing fallback here
  // silently swallowed unmapped domain error codes into an unlogged 500;
  // caught during this session's live-Firestore smoke test).
  request.log.error({ resourceId, err: error }, 'unmapped_domain_error');
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
