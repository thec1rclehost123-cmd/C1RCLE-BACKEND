import {
  opaqueIdSchema,
  scannerSessionCreateBodySchema,
  scannerSessionDtoSchema,
  startShiftResponseSchema,
  scannerSessionTokenHeaderSchema,
  scanRequestSchema,
  scanResponseSchema,
  ticketLookupResponseSchema,
  checkInDtoSchema,
  magicQrResponseSchema,
  offlineManifestRequestSchema,
  offlineManifestResponseSchema,
  offlineSyncRequestSchema,
  offlineSyncResponseSchema,
  overrideRequestSchema,
  overrideResponseSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { ScanResult, TicketResolution } from '@c1rcle/core/application';
import type { ScanLedger } from '@c1rcle/core/domain';

import { runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { mapDomainError } from '../partner/events.js';

import { sessionToDto } from './event-code-routes.js';

import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * ─── V2 door/scanner slice (Phase 5) ────────────────────────────────────────
 * Thin routes: validate → actor → scanner-session token → one `ScannerService`
 * call → serialize. Every route here is fully wired; there are no stubs left
 * in this file.
 *
 * **Two credentials, every scan.** The Better Auth session (cookie/Bearer,
 * plus `X-Organization-Id`) establishes the operator and the tenant.
 * `X-Scanner-Session-Token` — issued exactly once by `POST /door/sessions`,
 * stored only as a SHA-256 hash — establishes the device, the shift, the
 * event, and the permission set (`full` / `scan_only` / `charge`). The
 * previous version of this file trusted a `deviceId` string in the request
 * body for the second half, which any caller could supply; the permission
 * model was therefore decorative. It is now enforced.
 *
 * Door codes themselves (mint/list/revoke) are a manager concern and live in
 * `event-code-routes.ts`.
 */

const services = createV2Services();

const sessionIdParam = z.object({ sessionId: opaqueIdSchema });
const checkInIdParam = z.object({ checkInId: opaqueIdSchema });
const ticketIdParam = z.object({ ticketId: opaqueIdSchema });

/**
 * Pulls the scanner-session bearer off the request. Absent or malformed is
 * an empty string, which `authenticateSession` rejects with the same generic
 * `unauthorized` as a wrong one — a scanner must not be able to tell "you
 * sent no token" from "your token is not valid here" and work backwards.
 */
export function sessionTokenFrom(request: FastifyRequest): string {
  const raw = request.headers['x-scanner-session-token'];
  return typeof raw === 'string' ? raw : '';
}

export default async function phase5ScannerRoutes(fastify: FastifyInstance) {
  // ── POST /door/sessions ───────────────────────────────────────────────────
  // Redeem a door code for a device session. The only place a raw session
  // token is ever produced; `SENSITIVE_COMMAND` because this is the door's
  // credential-redemption surface and therefore its guessing surface.
  fastify.post(
    '/door/sessions',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ body: scannerSessionCreateBodySchema }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof scannerSessionCreateBodySchema>;
      const actor = services.actor(request);
      const idempotencyKey =
        typeof request.headers['idempotency-key'] === 'string'
          ? request.headers['idempotency-key']
          : undefined;

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'door.session.open',
        context: { path: {}, body },
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        run: async () => {
          // One call starts the whole shift: bind the handset, mint the
          // session, and return the event, its sellable tiers, the gate and
          // an opening stats snapshot. A door phone on club wifi may not get
          // a second round trip.
          const shift = await services.doorOps.startShift(
            {
              eventId: body.eventId,
              code: body.code,
              deviceId: body.deviceId,
              deviceName: body.deviceName,
              sessionType: body.sessionType,
            },
            actor,
          );
          const validated = validateV2Response(reply, request, startShiftResponseSchema, shift);
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        mapDomainError(reply, request, body.eventId, error, { hideForbidden: true }),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── GET /door/sessions/:sessionId ─────────────────────────────────────────
  fastify.get(
    '/door/sessions/:sessionId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: sessionIdParam })],
    },
    async (request, reply) => {
      const { sessionId } = request.params as z.infer<typeof sessionIdParam>;
      const actor = services.actor(request);
      const session = await services.scanner
        .getSession(sessionId, actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, sessionId, error, { hideForbidden: true }),
        );
      if (session === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        scannerSessionDtoSchema,
        sessionToDto(session),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door/check-ins ──────────────────────────────────────────────────
  // The real admission. Always 200 with a verdict: a refused guest is a
  // normal, expected outcome the door app must render, not an HTTP error.
  fastify.post(
    '/door/check-ins',
    {
      preHandler: [
        fastify.rateLimit('SCANNER_COMMAND'),
        fastify.validateV2({
          body: scanRequestSchema,
          headers: scannerSessionTokenHeaderSchema,
        }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof scanRequestSchema>;
      const actor = services.actor(request);
      const idempotencyKey =
        typeof request.headers['idempotency-key'] === 'string'
          ? request.headers['idempotency-key']
          : undefined;

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'door.check-in',
        context: { path: {}, body },
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        run: async () => {
          const scanResult: ScanResult = await services.scanner.scan(
            {
              eventId: body.eventId,
              qrPayload: body.qrPayload,
              sessionToken: sessionTokenFrom(request),
              ...(body.operatorName === undefined ? {} : { operatorName: body.operatorName }),
              ...(body.operatorRole === undefined ? {} : { operatorRole: body.operatorRole }),
              ...(body.gate === undefined ? {} : { gate: body.gate }),
            },
            actor,
          );
          const validated = validateV2Response(
            reply,
            request,
            scanResponseSchema,
            scanResultToDto(scanResult),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        mapDomainError(reply, request, body.eventId, error, { hideForbidden: true }),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── POST /door/check-ins/verify ───────────────────────────────────────────
  // Read-only preview: same rule, nothing written, nothing spent.
  fastify.post(
    '/door/check-ins/verify',
    {
      preHandler: [
        fastify.rateLimit('SCANNER_COMMAND'),
        fastify.validateV2({
          body: scanRequestSchema,
          headers: scannerSessionTokenHeaderSchema,
        }),
      ],
    },
    async (request, reply) => lookup(request, reply),
  );

  // ── POST /door/lookup ─────────────────────────────────────────────────────
  // Same non-mutating resolution under the name the door app uses when staff
  // are checking a guest rather than admitting them.
  fastify.post(
    '/door/lookup',
    {
      preHandler: [
        fastify.rateLimit('SCANNER_COMMAND'),
        fastify.validateV2({
          body: scanRequestSchema,
          headers: scannerSessionTokenHeaderSchema,
        }),
      ],
    },
    async (request, reply) => lookup(request, reply),
  );

  async function lookup(request: FastifyRequest, reply: Parameters<typeof validateV2Response>[0]) {
    const body = request.body as z.infer<typeof scanRequestSchema>;
    const actor = services.actor(request);
    const resolution = await services.scanner
      .resolve(
        {
          eventId: body.eventId,
          qrPayload: body.qrPayload,
          sessionToken: sessionTokenFrom(request),
        },
        actor,
      )
      .catch((error: unknown) =>
        mapDomainError(reply, request, body.eventId, error, { hideForbidden: true }),
      );
    if (resolution === undefined) return reply;
    const validated = validateV2Response(
      reply,
      request,
      ticketLookupResponseSchema,
      resolutionToDto(resolution),
    );
    if (validated === undefined) return reply;
    return reply.send(validated);
  }

  // ── GET /door/check-ins/:checkInId ────────────────────────────────────────
  fastify.get(
    '/door/check-ins/:checkInId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: checkInIdParam })],
    },
    async (request, reply) => {
      const { checkInId } = request.params as z.infer<typeof checkInIdParam>;
      const actor = services.actor(request);
      const scan = await services.scanner
        .getScan(checkInId, actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, checkInId, error, { hideForbidden: true }),
        );
      if (scan === undefined) return reply;
      const validated = validateV2Response(reply, request, checkInDtoSchema, checkInToDto(scan));
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door/override ───────────────────────────────────────────────────
  // Manual admission of a denied scan. `denied -> overridden` keeps both
  // halves of the story on one record: why entry was refused, and who let the
  // guest in anyway. Deliberately does not top the ticket back up.
  fastify.post(
    '/door/override',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ body: overrideRequestSchema }),
        fastify.requirePermission('ticket.override'),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof overrideRequestSchema>;
      const actor = services.actor(request);
      const scan = await services.scanner
        .overrideScan(body.checkInId, body.reason, actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, body.checkInId, error, { hideForbidden: true }),
        );
      if (scan === undefined) return reply;
      const validated = validateV2Response(reply, request, overrideResponseSchema, {
        checkInId: scan.id,
        status: 'overridden' as const,
        overriddenBy: scan.overriddenBy,
        overrideReason: scan.overrideReason,
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── GET /door/offline-manifest ────────────────────────────────────────────
  // Real, because the verifying side is real too: entries are signed with the
  // same key `POST /door/offline-sync` verifies, and syncing re-runs the full
  // atomic admission rather than trusting the device's decision. Shipping the
  // manifest without that verifying side (the reason this used to be a 501)
  // would have been a device trusting a signature nobody ever checked.
  fastify.get(
    '/door/offline-manifest',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          querystring: offlineManifestRequestSchema,
          headers: scannerSessionTokenHeaderSchema,
        }),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof offlineManifestRequestSchema>;
      const actor = services.actor(request);
      const manifest = await services.scanner
        .buildOfflineManifest(query.eventId, sessionTokenFrom(request), actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, query.eventId, error, { hideForbidden: true }),
        );
      if (manifest === undefined) return reply;
      const validated = validateV2Response(reply, request, offlineManifestResponseSchema, manifest);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door/offline-sync ───────────────────────────────────────────────
  // Replays a device's offline backlog through the same server-side decision
  // every online scan takes. Entries the server refuses come back as
  // `conflicts` — the operator's list of who got in on a bad ticket.
  fastify.post(
    '/door/offline-sync',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          body: offlineSyncRequestSchema,
          headers: scannerSessionTokenHeaderSchema,
        }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof offlineSyncRequestSchema>;
      const actor = services.actor(request);
      const idempotencyKey =
        typeof request.headers['idempotency-key'] === 'string'
          ? request.headers['idempotency-key']
          : undefined;

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'door.offline-sync',
        context: { path: {}, body },
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        run: async () => {
          const synced = await services.scanner.syncOfflineScans(
            {
              eventId: body.eventId,
              sessionToken: sessionTokenFrom(request),
              scans: body.scans,
            },
            actor,
          );
          const validated = validateV2Response(reply, request, offlineSyncResponseSchema, synced);
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        mapDomainError(reply, request, body.eventId, error, { hideForbidden: true }),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── GET /tickets/:ticketId/qr ─────────────────────────────────────────────
  // The rotating QR. Readable by the ticket holder or by staff of the org
  // running the event; anyone else gets a 404, never a 403, so a stranger
  // cannot confirm a ticket id exists.
  fastify.get(
    '/tickets/:ticketId/qr',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: ticketIdParam })],
    },
    async (request, reply) => {
      const { ticketId } = request.params as z.infer<typeof ticketIdParam>;
      const actor = services.actor(request);
      const result = await services.scanner
        .generateMagicTicketQr(ticketId, actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, ticketId, error, { hideForbidden: true }),
        );
      if (result === undefined) return reply;
      // A rotating credential must never sit in a cache.
      reply.header('cache-control', 'no-store');
      const validated = validateV2Response(reply, request, magicQrResponseSchema, result);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}

export function checkInToDto(scan: ScanLedger) {
  return {
    id: scan.id,
    eventId: scan.eventId,
    status: scan.status,
    denyReason: scan.denyReason,
    denyMessage: scan.denyMessage,
    entitlementId: scan.entitlementId,
    tierId: scan.tierId,
    tierName: scan.tierName,
    operatorUid: scan.operatorUid,
    operatorName: scan.operatorName,
    operatorRole: scan.operatorRole,
    gate: scan.gate,
    deviceId: scan.deviceId,
    guestName: scan.guestName,
    scannedAt: scan.scannedAt,
    admittedCount: scan.admittedCount,
    scanCountUsed: scan.scanCountUsed,
    scanCountAllowed: scan.scanCountAllowed,
    isOffline: scan.isOffline,
    overriddenBy: scan.overriddenBy,
    overrideReason: scan.overrideReason,
    createdAt: scan.createdAt,
  };
}

/**
 * `checkInId` is present only when something was actually written. A
 * `confirmation_required` response deliberately carries none: nothing has been
 * spent while the door waits for a human, and a client that saw an id there
 * could reasonably conclude the guest was already in.
 */
export function scanResultToDto(result: ScanResult) {
  return {
    status: result.status,
    ...(result.scan ? { checkInId: result.scan.id } : {}),
    denyReason: result.denyReason,
    denyMessage: result.denyMessage,
    entitlement: result.entitlement,
    ...(result.confirmation ? { confirmation: result.confirmation } : {}),
  };
}

function resolutionToDto(result: TicketResolution) {
  return {
    status: result.status,
    denyReason: result.denyReason,
    denyMessage: result.denyMessage,
    entitlement: result.entitlement,
  };
}
