import { buildV2ErrorResponse } from '@c1rcle/contracts';
import {
  opaqueIdSchema,
  idempotencyKeySchema,
  paginationQuerySchema,
  versionHeaderSchema,
  eventDtoSchema,
  eventOperationsDtoSchema,
  organizationEventListResponseSchema,
  promoterAssignedEventDtoSchema,
  promoterAssignmentDtoSchema,
  updateEventSchema,
  cancelEventSchema,
  posterUploadUrlRequestSchema,
  posterUploadUrlDtoSchema,
  eventPreviewDtoSchema,
  createEventSchema,
} from '@c1rcle/contracts/client';
import { promoterAssignmentStatusAt } from '@c1rcle/core/domain';
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

// Single source of truth for the create wire shape: the shared
// `createEventSchema` contract (what the client validates against). The
// gateway adds `.strict()` so unknown keys are rejected at the edge rather
// than silently dropped — the two schemas must never drift again.
const createEventBody = createEventSchema.strict();

const createEventHeaders = z.looseObject({
  'x-organization-id': opaqueIdSchema,
  'idempotency-key': idempotencyKeySchema,
  'if-match': versionHeaderSchema.optional(),
});

/** Read routes: no write-concurrency headers expected. */
const readHeaders = z.looseObject({
  'x-organization-id': opaqueIdSchema,
});

const eventListSchema = organizationEventListResponseSchema;
const assignedEventListSchema = z.array(promoterAssignedEventDtoSchema);
const promoterInvitationListSchema = z.array(promoterAssignmentDtoSchema);

export default async function partnerEventRoutes(fastify: FastifyInstance) {
  // Promoters see only events with an active assignment to their own org.
  // This is intentionally separate from the owner-scoped organization list.
  fastify.get(
    '/promoters/:promoterId/events',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: z.object({ promoterId: opaqueIdSchema }),
          headers: readHeaders,
        }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { promoterId } = request.params as { promoterId: string };
      const actor = services.actor(request);
      const events = await services.catalog
        .listAssignedEvents(actor, promoterId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, promoterId, error, { hideForbidden: true }),
        );
      if (events === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        assignedEventListSchema,
        events.map(({ event, assignment }) => ({
          event: eventToDto(event),
          assignment: {
            id: assignment.id,
            eventId: assignment.eventId,
            promoterId: assignment.promoterId,
            status: promoterAssignmentStatusAt(assignment, services.config().clock.now()),
            terms: assignment.terms,
            endedAt: assignment.endedAt,
            invitedAt: assignment.invitedAt,
            invitedBy: assignment.invitedBy,
            respondedAt: assignment.respondedAt,
            respondedBy: assignment.respondedBy,
            acceptedAt: assignment.acceptedAt,
            rejectedAt: assignment.rejectedAt,
            revokedAt: assignment.revokedAt,
            revokedBy: assignment.revokedBy,
            revocationReason: assignment.revocationReason,
            startsAt: assignment.startsAt,
            expiresAt: assignment.expiresAt,
            eligibleTierIds: assignment.eligibleTierIds,
            version: assignment.version,
            createdAt: assignment.createdAt,
            updatedAt: assignment.updatedAt,
          },
        })),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/promoters/:promoterId/assignment-invitations',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: z.object({ promoterId: opaqueIdSchema }),
          headers: readHeaders,
        }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { promoterId } = request.params as { promoterId: string };
      const actor = services.actor(request);
      const invitations = await services.catalog
        .listPromoterInvitations(actor, promoterId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, promoterId, error, { hideForbidden: true }),
        );
      if (invitations === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        promoterInvitationListSchema,
        invitations.map((assignment) => ({
          id: assignment.id,
          eventId: assignment.eventId,
          promoterId: assignment.promoterId,
          status: promoterAssignmentStatusAt(assignment, services.config().clock.now()),
          terms: assignment.terms,
          endedAt: assignment.endedAt,
          invitedAt: assignment.invitedAt,
          invitedBy: assignment.invitedBy,
          respondedAt: assignment.respondedAt,
          respondedBy: assignment.respondedBy,
          acceptedAt: assignment.acceptedAt,
          rejectedAt: assignment.rejectedAt,
          revokedAt: assignment.revokedAt,
          revokedBy: assignment.revokedBy,
          revocationReason: assignment.revocationReason,
          startsAt: assignment.startsAt,
          expiresAt: assignment.expiresAt,
          eligibleTierIds: assignment.eligibleTierIds,
          version: assignment.version,
          createdAt: assignment.createdAt,
          updatedAt: assignment.updatedAt,
        })),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

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
      reply.header('cache-control', 'private, no-store');
      const { organizationId } = request.params as z.infer<typeof orgIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      if (requirePathOrg(reply, request, actor, organizationId) === undefined) return reply;
      const page = await services.events.listWithOperations(actor, {
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
      const items = page.items.map(({ event, ...operations }) => ({
        ...eventToDto(event),
        ...operations,
      }));
      const payload = {
        items,
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
          nextCursor: page.nextCursor,
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
      reply.header('cache-control', 'private, no-store');
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const actor = services.actor(request);
      const event = await services.events
        .getWithOperations(actor, eventId)
        .catch((error: unknown) => {
          return mapDomainError(reply, request, eventId, error, { hideForbidden: true });
        });
      if (event === undefined) return reply;
      const validated = validateV2Response(reply, request, eventOperationsDtoSchema, {
        ...eventToDto(event.event),
        capacity: event.capacity,
        venueName: event.venueName,
        ticketsSold: event.ticketsSold,
        salesCountComplete: event.salesCountComplete,
      });
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
            slotRequestId: body.slotRequestId ?? null,
            title: body.title,
            summary: body.summary,
            description: body.description,
            imageUrl: body.imageUrl ?? null,
            startAt: body.startAt,
            endAt: body.endAt ?? null,
            tags: body.tags,
            compensation: body.compensation ?? null,
            entryRules: body.entryRules,
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

  // ── POSTER UPLOAD URL (mint a pre-signed PUT grant — the gateway never
  // sees the bytes; the client stores the returned `publicUrl` as `imageUrl`
  // on create) ──────────────────────────────────────────────────────────────
  fastify.post(
    '/organizations/:organizationId/poster/upload-url',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: orgIdParam,
          body: posterUploadUrlRequestSchema,
          headers: readHeaders,
        }),
        fastify.requirePermission('event.create'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof orgIdParam>;
      const body = request.body as z.infer<typeof posterUploadUrlRequestSchema>;
      const actor = services.actor(request);
      if (requirePathOrg(reply, request, actor, organizationId) === undefined) return reply;
      const grant = await services.events
        .issuePosterUploadUrl(actor, body)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (grant === undefined) return reply;
      const validated = validateV2Response(reply, request, posterUploadUrlDtoSchema, grant);
      if (validated === undefined) return reply;
      return reply.send(validated);
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
      reply.header('cache-control', 'private, no-store');
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
  // Tenant-scoped read, mirroring GET /events/:eventId: a preview of an
  // unpublished event leaks the full DTO, so it needs `event.read` and the
  // service's ownership check (cross-tenant → 404, never a cross-org 200).
  fastify.get(
    '/events/:eventId/previews',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: eventIdParam, headers: readHeaders }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const actor = services.actor(request);
      const preview = await services.events
        .getPreview(actor, eventId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (preview === undefined) return reply;
      const validated = validateV2Response(reply, request, eventPreviewDtoSchema, {
        event: eventToDto(preview.event),
        isPublic: preview.isPublic,
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── LIFECYCLE ACTIONS (idempotent; each maps 1:1 to an `EventService`
  // method — the FSM validation lives in the domain model, never here) ───────
  // These accept an optional `If-Match` header but do NOT enforce it: the
  // transition is guarded by the FSM and the repository's compare-and-set,
  // which return a 409 `version_conflict` on a stale/racy write.
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
  const visibilityMode = event.visibilityMode ?? 'public';
  const privateEvent = visibilityMode === 'code' || visibilityMode === 'invited';
  return {
    id: event.id,
    organizationId: event.organizationId,
    venueId: event.venueId,
    slug: event.slug,
    title: event.title,
    summary: event.summary,
    description: event.description,
    // Never serialize a public object URL for restricted events. Older private
    // records may predate managed poster ACL revocation, and promoter/partner
    // projections must not re-expose those historical URLs.
    imageUrl: privateEvent ? null : event.imageUrl,
    startAt: event.startAt,
    endAt: event.endAt,
    status: event.status,
    visibilityMode,
    addressDisclosure:
      event.addressDisclosure ??
      (event.visibilityMode === 'code' || event.visibilityMode === 'invited' ? 'hidden' : 'public'),
    isPublic: event.isPublic,
    tags: event.tags,
    startingPricePaise: event.startingPricePaise,
    isFree: event.isFree,
    cancellationReason: event.cancellationReason,
    compensation: event.compensation ?? null,
    ...(event.entryRules === undefined ? {} : { entryRules: event.entryRules }),
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
    'promoter_assignment_not_found',
    'slot_request_not_found',
    'partnership_not_found',
    'ticket_tier_not_found',
    'promoter_assignment_not_found',
    'onboarding_request_not_found',
    'proposal_not_found',
    'notification_not_found',
    // The generic `NotFoundError` (domain/errors.ts) carries this exact code —
    // previously missing here, so an order/ticket "not found" fell through
    // every branch below into the unmapped-error 500 (docs/architecture/
    // IMPLEMENTATION-STATUS-2026-08-31.md §2 named this gotcha already).
    'not_found',
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
  // No session at all (or no platform-admin authority) — distinct from
  // `forbidden`, which means a valid identity in the wrong scope.
  if (known?.code === 'unauthorized') {
    reply.status(401).send(
      buildV2ErrorResponse({
        status: 401,
        message: known.message ?? 'Authentication required',
        code: 'unauthorized',
        requestId: request.id,
      }),
    );
    return undefined;
  }
  if (known?.code === 'device_not_authorized') {
    // Never masked as a 404, even on routes that hide `forbidden`: door staff
    // need to be told the handset is deauthorized, and there is nothing to
    // hide from a caller who already proved tenancy and a live session.
    reply.status(403).send(
      buildV2ErrorResponse({
        status: 403,
        message: known.message ?? 'Device not authorized',
        code: 'forbidden',
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
  // Business-rule duplicate (e.g. a second RSVP for the same user+event) —
  // distinct from optimistic-locking (`version_conflict`) and key reuse
  // (`idempotency_*`): the request itself is disallowed by current state.
  if (known?.code === 'conflict') {
    reply.status(409).send(
      buildV2ErrorResponse({
        status: 409,
        message: known.message ?? 'Conflict',
        code: 'conflict',
        requestId: request.id,
      }),
    );
    return undefined;
  }
  // A captured payment that could not be honoured and was refunded. 409 with the
  // server's message: the buyer must be told they were refunded, not to retry.
  if (known?.code === 'payment_refunded') {
    reply.status(409).send(
      buildV2ErrorResponse({
        status: 409,
        message: known.message ?? 'Your payment has been refunded',
        code: 'conflict',
        requestId: request.id,
        details: { outcome: 'refunded' },
      }),
    );
    return undefined;
  }
  if (
    known?.code === 'idempotency_conflict' ||
    known?.code === 'idempotency_in_flight' ||
    // B1: a prior attempt failed at an unknown point (possibly after the
    // durable write). The claim is kept so a retry can NOT re-run; the client
    // gets the distinct message and inspects instead of retrying.
    known?.code === 'idempotency_failed'
  ) {
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
  if (known?.code === 'service_unavailable') {
    reply.status(503).send(
      buildV2ErrorResponse({
        status: 503,
        message: known.message ?? 'This feature is not enabled',
        code: 'server',
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
