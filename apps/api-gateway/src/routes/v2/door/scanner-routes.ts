import { buildV2ErrorResponse } from '@c1rcle/contracts';
import {
  opaqueIdSchema,
  scannerSessionCreateBodySchema,
  scannerSessionDtoSchema,
  scanRequestSchema,
  scanResponseSchema,
  magicQrResponseSchema,
  offlineSyncRequestSchema,
  offlineSyncResponseSchema,
  overrideResponseSchema,
} from '@c1rcle/contracts/client';
import { InvalidOperationError } from '@c1rcle/core/domain';
import { z } from 'zod';

import type { ScanResult, TicketResolution } from '@c1rcle/core/application';
import type { ScanLedger, ScannerSession } from '@c1rcle/core/domain';

import { runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services, type PartnerV2Services } from '../../../lib/v2-services.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── V2 door/scanner slice (Phase 5, Builder A) ─────────────────────────────
 * Thin routes: validate -> build actor -> call `ScannerService` -> serialize.
 * Registered by whoever wires `route-manifest.ts` — this file only exports
 * the plugin function, it does not register itself anywhere.
 *
 * One of the ten routes below (`GET /door/offline-manifest`) is still an
 * honest 501 stub, not real wiring — see the comment on it. `POST
 * /door/override` used to be the other one; it's now real (a `denied ->
 * overridden` FSM transition, see `domain/models/scan-ledger.ts`).
 * Everything else below is fully wired to the real, already-built Phase 5
 * application services.
 */

const services: PartnerV2Services = createV2Services();

/**
 * ─── QR payload decode (plan point 2) ───────────────────────────────────────
 * Investigated rather than guessed: `packages/core/src/domain/models/entitlement.ts`
 * states the regular-ticket QR payload is deliberately NOT persisted anywhere
 * in Phase 4 backend code — nothing in `packages/core` or the Phase 4 checkout
 * routes generates or encodes one. The ONLY concrete QR encoding that exists
 * anywhere in this codebase is the magic-ticket format implemented in
 * `scanner-service.ts`'s `scanMagicTicket`: `entitlementId:floor(unixTime/30):hmac`
 * (3 colon-separated parts). `opaqueIdSchema` (packages/contracts/src/contracts/shared.ts)
 * forbids ':' in any entity id, so a payload with exactly 2 colons can never
 * be a bare entitlementId — the two cases are mutually exclusive by
 * construction, not by heuristic. Anything that isn't the 3-part magic format
 * is therefore treated as a direct entitlementId, matching `scanTicket`'s
 * input contract (`entitlementId: EntityId`) exactly.
 */
function decodeQrPayload(
  qrPayload: string,
): { kind: 'magic' } | { kind: 'direct'; entitlementId: string } {
  const parts = qrPayload.split(':');
  if (parts.length === 3 && parts.every((part) => part.length > 0)) {
    return { kind: 'magic' };
  }
  return { kind: 'direct', entitlementId: qrPayload };
}

const sessionIdParam = z.object({ sessionId: opaqueIdSchema });
const checkInIdParam = z.object({ checkInId: opaqueIdSchema });
const ticketIdParam = z.object({ ticketId: opaqueIdSchema });

const overrideBody = z.object({ checkInId: opaqueIdSchema, reason: z.string().min(1) }).strict();

const offlineManifestQuery = z
  .object({
    eventId: opaqueIdSchema,
    scannerSessionId: opaqueIdSchema,
    expiresAt: z.string().min(1),
  })
  .strict();

/**
 * `scannerSessionDtoSchema.sessionToken` is a required non-empty string, but
 * `ScannerSession.sessionToken` is deliberately `null` on every read after
 * creation (domain comment: "only returned on creation" — a raw token
 * shouldn't be re-servable from a GET). GET /door/sessions/:sessionId uses
 * this locally-adjusted schema instead of the contract one, rather than
 * either violating that security intent or leaking a fabricated token.
 */
const scannerSessionReadDto = scannerSessionDtoSchema
  .omit({ sessionToken: true })
  .extend({ sessionToken: z.null() });

const checkInDetailDto = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  status: z.enum(['pending', 'consumed', 'denied', 'cancelled', 'revoked', 'expired']),
  denyReason: z.string().nullable(),
  denyMessage: z.string().nullable(),
  entitlementId: z.string().nullable(),
  tierId: z.string().nullable(),
  tierName: z.string().nullable(),
  operatorUid: z.string().nullable(),
  operatorName: z.string().nullable(),
  operatorRole: z.string().nullable(),
  gate: z.string().nullable(),
  deviceId: z.string().nullable(),
  guestName: z.string().nullable(),
  scannedAt: z.string(),
  admittedCount: z.number().int(),
  scanCountUsed: z.number().int().nullable(),
  scanCountAllowed: z.number().int().nullable(),
  isOffline: z.boolean(),
  createdAt: z.string(),
});

export default async function phase5ScannerRoutes(fastify: FastifyInstance) {
  // ── POST /door/sessions ─────────────────────────────────────────────────
  // Two service calls, not one (plan point 1): resolve the human `code`
  // string to an `EventCode` via `validateEventCode`, then mint a session
  // from its `codeId` via `createScannerSession`.
  fastify.post(
    '/door/sessions',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
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
        commandName: 'door.session.create',
        idempotencyKey,
        context: { path: {}, body },
        run: async () => {
          const eventCode = await services.scanner.validateEventCode(body.code, actor);
          if (eventCode.eventId !== body.eventId) {
            throw new InvalidOperationError('Event code does not belong to the given event');
          }
          const created = await services.scanner.createScannerSession(
            {
              codeId: eventCode.id,
              codeData: {
                id: eventCode.id,
                code: eventCode.code,
                eventId: eventCode.eventId,
                venueId: eventCode.venueId,
                type: eventCode.type,
                gate: eventCode.gate,
                maxDevices: eventCode.maxDevices,
                allowReuse: eventCode.allowReuse,
              },
              deviceId: body.deviceId,
              deviceName: body.deviceName,
              // ActorContext carries no display name — userId is the best
              // available audit label here.
              createdBy: actor.userId,
              createdByName: actor.userId,
              sessionType: body.sessionType,
            },
            actor,
          );
          const dto = {
            id: created.sessionId,
            eventId: created.session.eventId,
            codeId: created.session.codeId,
            sessionToken: created.sessionToken,
            sessionExpiresAt: created.sessionExpiresAt,
            permissions: created.session.permissions,
            status: 'active' as const,
            createdAt: created.session.createdAt,
          };
          const validated = validateV2Response(reply, request, scannerSessionDtoSchema, dto);
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) => mapDomainError(reply, request, body.eventId, error));
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── GET /door/sessions/:sessionId ───────────────────────────────────────
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
      const dto = sessionToReadDto(session);
      const validated = validateV2Response(reply, request, scannerSessionReadDto, dto);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door/check-ins ────────────────────────────────────────────────
  // Real admission decision — consumes the entitlement (or records a denial)
  // via `scanTicket`/`scanMagicTicket` depending on the decoded payload kind.
  fastify.post(
    '/door/check-ins',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: scanRequestSchema }),
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
        idempotencyKey,
        context: { path: {}, body },
        run: async () => {
          const decoded = decodeQrPayload(body.qrPayload);
          const scanResult: ScanResult =
            decoded.kind === 'magic'
              ? await services.scanner.scanMagicTicket(
                  {
                    eventId: body.eventId,
                    qrPayload: body.qrPayload,
                    gate: body.gate ?? '',
                    deviceId: body.deviceId ?? '',
                    operatorUid: body.scannedBy.uid,
                    operatorName: body.scannedBy.name,
                    operatorRole: body.scannedBy.role,
                    scannedAt: new Date().toISOString(),
                  },
                  actor,
                )
              : await services.scanner.scanTicket(
                  {
                    eventId: body.eventId,
                    entitlementId: decoded.entitlementId,
                    gate: body.gate ?? '',
                    deviceId: body.deviceId ?? '',
                    operatorUid: body.scannedBy.uid,
                    operatorName: body.scannedBy.name,
                    operatorRole: body.scannedBy.role,
                    scannedAt: new Date().toISOString(),
                    isOffline: body.isOffline,
                  },
                  actor,
                );
          const dto = scanResultToDto(scanResult);
          const validated = validateV2Response(reply, request, scanResponseSchema, dto);
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) => mapDomainError(reply, request, body.eventId, error));
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── POST /door/check-ins/verify ─────────────────────────────────────────
  // Read-only preview. `scanTicket`/`scanMagicTicket` have no dry-run flag
  // (plan point 2's investigation) — rather than call the mutating path and
  // pretend it's non-mutating, this calls the new `resolveTicket`/
  // `resolveMagicTicket` methods added to `ScannerService` for this route,
  // which mirror the same checks without writing a scan-ledger entry.
  fastify.post(
    '/door/check-ins/verify',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ body: scanRequestSchema })],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof scanRequestSchema>;
      const actor = services.actor(request);
      const decoded = decodeQrPayload(body.qrPayload);
      let resolution: TicketResolution;
      try {
        resolution =
          decoded.kind === 'magic'
            ? await services.scanner.resolveMagicTicket(
                { eventId: body.eventId, qrPayload: body.qrPayload, deviceId: body.deviceId ?? '' },
                actor,
              )
            : await services.scanner.resolveTicket(
                {
                  eventId: body.eventId,
                  entitlementId: decoded.entitlementId,
                  deviceId: body.deviceId ?? '',
                },
                actor,
              );
      } catch (error) {
        return mapDomainError(reply, request, body.eventId, error);
      }
      const dto = ticketResolutionToDto(resolution);
      const validated = validateV2Response(reply, request, scanResponseSchema, dto);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── GET /door/check-ins/:checkInId ──────────────────────────────────────
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
      const dto = scanToDetailDto(scan);
      const validated = validateV2Response(reply, request, checkInDetailDto, dto);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door/lookup ────────────────────────────────────────────────────
  // Same read-only resolution as /door/check-ins/verify — the plan lists
  // these as two routes ("preview a scan" vs "look up a ticket") but neither
  // the plan nor any contract distinguishes their behavior, so both wrap the
  // same non-mutating resolution.
  fastify.post(
    '/door/lookup',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ body: scanRequestSchema })],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof scanRequestSchema>;
      const actor = services.actor(request);
      const decoded = decodeQrPayload(body.qrPayload);
      let resolution: TicketResolution | undefined;
      try {
        resolution =
          decoded.kind === 'magic'
            ? await services.scanner.resolveMagicTicket(
                { eventId: body.eventId, qrPayload: body.qrPayload, deviceId: body.deviceId ?? '' },
                actor,
              )
            : await services.scanner.resolveTicket(
                {
                  eventId: body.eventId,
                  entitlementId: decoded.entitlementId,
                  deviceId: body.deviceId ?? '',
                },
                actor,
              );
      } catch (error) {
        return mapDomainError(reply, request, body.eventId, error);
      }
      const dto = ticketResolutionToDto(resolution);
      const validated = validateV2Response(reply, request, scanResponseSchema, dto);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door/override ─────────────────────────────────────────────────
  // `ScanLedgerStatus` gained a real `denied -> overridden` transition
  // (domain/models/scan-ledger.ts) — a terminal state distinct from
  // `consumed`, recording who overrode the denial and why on the same
  // record the denial itself is on. `ScannerService.overrideScan` enforces
  // `ticket.override` (route-level) + org scope + the FSM guard (rejects
  // overriding anything that isn't currently `denied`).
  fastify.post(
    '/door/override',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ body: overrideBody }),
        fastify.requirePermission('ticket.override'),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof overrideBody>;
      const actor = services.actor(request);
      const scan = await services.scanner
        .overrideScan(body.checkInId, body.reason, actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, body.checkInId, error, { hideForbidden: true }),
        );
      if (scan === undefined) return reply;
      const payload = {
        checkInId: scan.id,
        status: 'overridden' as const,
        overriddenBy: scan.overriddenBy,
        overrideReason: scan.overrideReason,
      };
      const validated = validateV2Response(reply, request, overrideResponseSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── GET /door/offline-manifest ──────────────────────────────────────────
  // HONEST 501, not real wiring. No `ScannerService` method generates this,
  // and — more importantly — nothing in `syncOfflineScans` (or anywhere else)
  // verifies a manifest signature. Inventing a signing scheme here would be
  // unverified security theater: a device would trust a signature the server
  // never checks on the way back in. Flagged in the report.
  fastify.get(
    '/door/offline-manifest',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: offlineManifestQuery }),
      ],
    },
    async (_request, reply) => {
      return reply.status(501).send({
        error:
          'Not yet implemented: generating a signed manifest is straightforward, but ' +
          'POST /door/offline-sync (a frozen, already-consumed wire contract) has no field to ' +
          'carry a manifest signature back for verification, and no ScannerService method ' +
          're-validates an offline decision against server state at sync time either. Shipping ' +
          'the manifest alone — without a verifying side — would be a device trusting a ' +
          'signature the server never checks on the way back in. Needs a contract change ' +
          'decision, not a route-wiring one. See FOUNDER-TASKS-2026-08-29.md Task A2.',
      });
    },
  );

  // ── POST /door/offline-sync ──────────────────────────────────────────────
  // `syncOfflineScans` is a raw bulk-insert (it hardcodes status 'pending'
  // for everything — createScanLedger ignores any status/denyReason on its
  // input) with no per-scan authorization of its own. This route derives
  // eventId/venueId from an org-checked scanner session lookup, and uses
  // `actor.organizationId` (not `session.organizationId`, which is
  // unreliable — see the comment on `getSession` in scanner-service.ts) so
  // every synced record is stamped with a verified org.
  fastify.post(
    '/door/offline-sync',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: offlineSyncRequestSchema }),
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
        idempotencyKey,
        context: { path: {}, body },
        run: async () => {
          const session = await services.scanner.getSession(body.scannerSessionId, actor);
          const scanInputs = body.scans.map((scan) => {
            const decoded = decodeQrPayload(scan.payload);
            const entitlementId =
              decoded.kind === 'magic' ? (scan.payload.split(':')[0] ?? '') : decoded.entitlementId;
            return {
              eventId: session.eventId,
              organizationId: actor.organizationId,
              venueId: session.venueId,
              entitlementId,
              doorSaleId: null,
              entryType: null,
              tierName: null,
              tierId: null,
              operatorUid: null,
              operatorName: null,
              operatorRole: null,
              gate: null,
              deviceId: scan.deviceId,
              deviceName: session.deviceName,
              deviceBound: true,
              guestName: null,
              guestEmail: null,
              guestPhone: null,
              scannedAt: scan.scannedAt,
              admittedCount: 1,
              scanCountUsed: null,
              scanCountAllowed: null,
              isOffline: true,
              offlineDeviceId: scan.deviceId,
            };
          });
          const created = await services.scanner.syncOfflineScans(scanInputs, actor);
          const dto = {
            synced: created.length,
            conflicts: [] as { payload: string; reason: string }[],
          };
          const validated = validateV2Response(reply, request, offlineSyncResponseSchema, dto);
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) => mapDomainError(reply, request, body.scannerSessionId, error));
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── GET /tickets/:ticketId/qr ────────────────────────────────────────────
  // `ticketId` is the entitlementId. Does NOT enforce the >= Rs 5000
  // eligibility threshold server-side (see comment on `generateMagicTicketQr`
  // in scanner-service.ts) — flagged in the report.
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
      const validated = validateV2Response(reply, request, magicQrResponseSchema, result);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}

function sessionToReadDto(session: ScannerSession) {
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
    permissions: session.permissions,
    status,
    createdAt: session.createdAt,
  };
}

function scanToDetailDto(scan: ScanLedger) {
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
    createdAt: scan.createdAt,
  };
}

function scanResultToDto(result: ScanResult) {
  return {
    status: result.status,
    checkInId: result.scan.id,
    denyReason: result.denyReason,
    denyMessage: result.denyMessage,
    entitlement: result.entitlement
      ? {
          id: result.entitlement.id,
          tierName: result.entitlement.tierName,
          holderName: result.entitlement.holderName,
          scansUsed: result.entitlement.scansUsed,
          scansAllowed: result.entitlement.scansAllowed,
        }
      : undefined,
  };
}

/**
 * `scanResponseSchema.status` only has `'consumed' | 'denied'` — there is no
 * third "would be valid" wire value. A preview's `'valid'` outcome maps to
 * `'consumed'` on the wire; the absence of `checkInId` (nothing was
 * persisted) is what actually distinguishes a preview response from a real
 * scan response.
 */
function ticketResolutionToDto(result: TicketResolution) {
  return {
    status: result.status === 'valid' ? ('consumed' as const) : ('denied' as const),
    denyReason: result.denyReason,
    denyMessage: result.denyMessage,
    entitlement: result.entitlement
      ? {
          id: result.entitlement.id,
          tierName: result.entitlement.tierName,
          holderName: result.entitlement.holderName,
          scansUsed: result.entitlement.scansUsed,
          scansAllowed: result.entitlement.scansAllowed,
        }
      : undefined,
  };
}

/** Local copy of the V2 domain-error mapping (plan point 4: the central
 * `error-handler.ts`'s `mapDomainError` only maps specific `*NotFoundError`
 * subclasses to 404 — Phase 5 services throw the generic `NotFoundError`
 * (`code: 'not_found'`), which falls through to an unlogged 500 there. This
 * copy handles `'not_found'` as a first-class branch, matching
 * `partner/events.ts:418`'s pattern. */
function mapDomainError(
  reply: FastifyReply,
  request: FastifyRequest,
  resourceId: string,
  error: unknown,
  options: { hideForbidden?: boolean } = {},
): undefined {
  const known = error as { code?: string; message?: string };
  if (known?.code === 'not_found') {
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
  if (known?.code === 'forbidden') {
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
  if (known?.code === 'idempotency_conflict' || known?.code === 'idempotency_in_flight') {
    reply.status(409).send(
      buildV2ErrorResponse({
        status: 409,
        message: known.message ?? 'Idempotency conflict',
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
  if (known?.code === 'state_transition') {
    // e.g. POST /door/override on a scan that isn't currently `denied`.
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
