import {
  opaqueIdSchema,
  eventCodeCreateBodySchema,
  eventCodeDtoSchema,
  eventCodeListResponseSchema,
  revokeReasonBodySchema,
  scannerSessionDtoSchema,
  paginationQuerySchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { EventCode, ScannerSession } from '@c1rcle/core/domain';

import { runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Door-code management (Phase 5) ─────────────────────────────────────────
 *
 * The missing half of the scanner story. The services to mint, list and
 * revoke door codes existed but were registered on no route, so in production
 * there was no way to issue a scanner a credential at all — the door could
 * only be opened by writing to Firestore by hand. These are those routes.
 *
 * They are deliberately manager-facing, not device-facing: a door code IS the
 * credential a device redeems, so handing one out is a `door.manage` act, not
 * a scanning one. Door staff scan; a manager decides who may scan.
 *
 * Every route is scoped by the event's own organization, so two clubs running
 * two events on the same night can never see or revoke each other's codes.
 */

const services = createV2Services();

const eventIdParam = z.object({ eventId: opaqueIdSchema });
const codeIdParam = z.object({ codeId: opaqueIdSchema });
const sessionIdParam = z.object({ sessionId: opaqueIdSchema });

export default async function doorCodeRoutes(fastify: FastifyInstance) {
  // ── POST /events/:eventId/door-codes ──────────────────────────────────────
  fastify.post(
    '/events/:eventId/door-codes',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: eventIdParam, body: eventCodeCreateBodySchema }),
        fastify.requirePermission('door.manage'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const body = request.body as z.infer<typeof eventCodeCreateBodySchema>;
      const actor = services.actor(request);
      const idempotencyKey =
        typeof request.headers['idempotency-key'] === 'string'
          ? request.headers['idempotency-key']
          : undefined;

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'door.code.create',
        idempotencyKey,
        context: { path: { eventId }, body },
        run: async () => {
          const created = await services.scanner.createEventCode(
            {
              eventId,
              type: body.type,
              gate: body.gate,
              ...(body.maxDevices === undefined ? {} : { maxDevices: body.maxDevices }),
              ...(body.allowReuse === undefined ? {} : { allowReuse: body.allowReuse }),
              expiresAt: body.expiresAt,
            },
            actor,
          );
          const validated = validateV2Response(
            reply,
            request,
            eventCodeDtoSchema,
            eventCodeToDto(created),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        // Cross-tenant is a 404, not a 403: a 403 here would confirm that
        // another club's event exists.
        mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── GET /events/:eventId/door-codes ───────────────────────────────────────
  // Returns the code strings, so it is gated on `door.manage` exactly like
  // minting one — a read that hands out a working credential is not a read.
  fastify.get(
    '/events/:eventId/door-codes',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: eventIdParam }),
        fastify.requirePermission('door.manage'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const actor = services.actor(request);
      const codes = await services.scanner
        .listEventCodes(eventId, actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (codes === undefined) return reply;
      const validated = validateV2Response(reply, request, eventCodeListResponseSchema, {
        items: codes.map(eventCodeToDto),
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door-codes/:codeId/revoke ───────────────────────────────────────
  // Revoking also closes every live session the code opened — see
  // `ScannerService.revokeEventCode`. A revoked code whose devices keep
  // scanning is not revoked.
  fastify.post(
    '/door-codes/:codeId/revoke',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: codeIdParam, body: revokeReasonBodySchema }),
        fastify.requirePermission('door.manage'),
      ],
    },
    async (request, reply) => {
      const { codeId } = request.params as z.infer<typeof codeIdParam>;
      const body = request.body as z.infer<typeof revokeReasonBodySchema>;
      const actor = services.actor(request);
      const revoked = await services.scanner
        .revokeEventCode(codeId, body.reason, actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, codeId, error, { hideForbidden: true }),
        );
      if (revoked === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        eventCodeDtoSchema,
        eventCodeToDto(revoked),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── GET /door-codes/:codeId/sessions ──────────────────────────────────────
  // Which devices are live on this code right now — the answer to "who is
  // scanning at my door", and the list a manager revokes from.
  fastify.get(
    '/door-codes/:codeId/sessions',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: codeIdParam, querystring: paginationQuerySchema }),
        fastify.requirePermission('door.manage'),
      ],
    },
    async (request, reply) => {
      const { codeId } = request.params as z.infer<typeof codeIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.scanner
        .listSessionsForCode(codeId, { cursor: query.cursor ?? null, limit: query.limit }, actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, codeId, error, { hideForbidden: true }),
        );
      if (page === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        z.object({ items: z.array(scannerSessionDtoSchema) }),
        { items: page.items.map(sessionToDto) },
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door/sessions/:sessionId/revoke ─────────────────────────────────
  // The "a device was lost/stolen mid-shift" button.
  fastify.post(
    '/door/sessions/:sessionId/revoke',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: sessionIdParam, body: revokeReasonBodySchema }),
        fastify.requirePermission('door.manage'),
      ],
    },
    async (request, reply) => {
      const { sessionId } = request.params as z.infer<typeof sessionIdParam>;
      const body = request.body as z.infer<typeof revokeReasonBodySchema>;
      const actor = services.actor(request);
      const revoked = await services.scanner
        .revokeSession(sessionId, body.reason, actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, sessionId, error, { hideForbidden: true }),
        );
      if (revoked === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        scannerSessionDtoSchema,
        sessionToDto(revoked),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}

function eventCodeToDto(code: EventCode) {
  return {
    id: code.id,
    code: code.code,
    eventId: code.eventId,
    organizationId: code.organizationId,
    venueId: code.venueId,
    type: code.type,
    gate: code.gate,
    status: code.status,
    maxDevices: code.maxDevices,
    allowReuse: code.allowReuse,
    expiresAt: code.expiresAt,
    revokedAt: code.revokedAt,
    revokedReason: code.revokedReason,
    stats: code.stats,
    createdAt: code.createdAt,
  };
}

/** `sessionToken` is always null on a read — see the contract's doc comment. */
export function sessionToDto(session: ScannerSession) {
  const status: 'active' | 'revoked' | 'expired' = session.revokedAt
    ? 'revoked'
    : new Date(session.expiresAt) < new Date()
      ? 'expired'
      : 'active';
  return {
    id: session.id,
    eventId: session.eventId,
    codeId: session.codeId,
    sessionToken: null,
    sessionExpiresAt: session.expiresAt,
    deviceId: session.deviceId,
    deviceName: session.deviceName,
    permissions: session.permissions,
    status,
    createdAt: session.createdAt,
  };
}
