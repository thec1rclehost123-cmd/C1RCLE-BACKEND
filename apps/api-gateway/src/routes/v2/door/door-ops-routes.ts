import {
  confirmCoupleBodySchema,
  doorEventListQuerySchema,
  doorEventListResponseSchema,
  doorGuestListQuerySchema,
  doorGuestListResponseSchema,
  manualCheckInBodySchema,
  manualCheckInResponseSchema,
  paginationQuerySchema,
  scanResponseSchema,
  scannerDeviceBindBodySchema,
  scannerDeviceReauthorizeBodySchema,
  scannerDeviceDtoSchema,
  scannerDeviceListResponseSchema,
  scannerHeartbeatBodySchema,
  scannerSessionTokenHeaderSchema,
  staffDenyBodySchema,
  walletQrResolveBodySchema,
  walletChargeViewSchema,
  walletChargeBodySchema,
  walletChargeResponseSchema,
  doorTicketSaleBodySchema,
  doorTicketSaleResponseSchema,
  checkInDtoSchema,
  revokeReasonBodySchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { ScanResult } from '@c1rcle/core/application';
import type { ScannerDevice } from '@c1rcle/core/domain';

import { runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { mapDomainError } from '../partner/events.js';

import { checkInToDto, scanResultToDto, sessionTokenFrom } from './scanner-routes.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Door operations (Phase 5) ──────────────────────────────────────────────
 *
 * Everything the scanner app does that is not the camera: pick tonight's
 * event, register the handset, keep it visible on the dashboard, work the
 * guest roster, check someone in by hand, confirm a couple, record a refusal.
 *
 * Split from `scanner-routes.ts` deliberately — that file owns the admission
 * decision and is the security-critical one; these are the screens around it.
 *
 * Two credential levels are used here, and the difference is intentional:
 *  - **Session token** (`X-Scanner-Session-Token`) for anything a device does
 *    during a shift: heartbeat, confirm, staff-deny. The device proves it is
 *    on the door right now.
 *  - **`door.manage`** for anything that hands out or withdraws authority:
 *    listing and unbinding devices. Those are manager acts.
 */

const services = createV2Services();

const deviceIdParam = z.object({ deviceId: z.string().min(16).max(128) });

export default async function doorOpsRoutes(fastify: FastifyInstance) {
  // ── GET /door/events ──────────────────────────────────────────────────────
  // Tonight's events at this organization. Drafts and cancelled events are
  // excluded: neither can admit anyone, so offering them would only produce a
  // shift that denies everything.
  fastify.get(
    '/door/events',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: doorEventListQuerySchema }),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof doorEventListQuerySchema>;
      const actor = services.actor(request);
      const events = await services.doorOps
        .listEvents(query.date, actor)
        .catch((error: unknown) => mapDomainError(reply, request, query.date, error));
      if (events === undefined) return reply;
      const validated = validateV2Response(reply, request, doorEventListResponseSchema, {
        items: events,
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door/devices ────────────────────────────────────────────────────
  // Authorize this handset for the venue's doors, or refresh an existing
  // authorization. The app calls this on launch; `POST /door/sessions` also
  // does it implicitly so a shift never blocks on pre-registration.
  fastify.post(
    '/door/devices',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: scannerDeviceBindBodySchema }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof scannerDeviceBindBodySchema>;
      const actor = services.actor(request);
      const device = await services.scanner
        .bindDevice({ deviceId: body.deviceId, deviceName: body.deviceName }, actor)
        .catch((error: unknown) => mapDomainError(reply, request, body.deviceId, error));
      if (device === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        scannerDeviceDtoSchema,
        deviceToDto(device),
      );
      if (validated === undefined) return reply;
      return reply.status(201).send(validated);
    },
  );

  // ── GET /door/devices ─────────────────────────────────────────────────────
  // Which handsets this venue has authorized, and which are live right now.
  fastify.get(
    '/door/devices',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: paginationQuerySchema }),
        fastify.requirePermission('door.manage'),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.scanner
        .listDevices({ cursor: query.cursor ?? null, limit: query.limit }, actor)
        .catch((error: unknown) => mapDomainError(reply, request, 'devices', error));
      if (page === undefined) return reply;
      const validated = validateV2Response(reply, request, scannerDeviceListResponseSchema, {
        items: page.items.map(deviceToDto),
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door/devices/:deviceId/unbind ───────────────────────────────────
  // The "this phone was lost" button. Stops the device scanning immediately —
  // its session token is still cryptographically valid, and that is exactly
  // why the binding is a separate record.
  fastify.post(
    '/door/devices/:deviceId/unbind',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: deviceIdParam, body: revokeReasonBodySchema }),
        fastify.requirePermission('door.manage'),
      ],
    },
    async (request, reply) => {
      const { deviceId } = request.params as z.infer<typeof deviceIdParam>;
      const body = request.body as z.infer<typeof revokeReasonBodySchema>;
      const actor = services.actor(request);
      const device = await services.scanner
        .unbindDevice(deviceId, body.reason, actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, deviceId, error, { hideForbidden: true }),
        );
      if (device === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        scannerDeviceDtoSchema,
        deviceToDto(device),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door/devices/:deviceId/reauthorize ──────────────────────────────
  // Turns a previously unbound handset back on. `door.manage`, deliberately:
  // the ungated `POST /door/devices` must not be able to walk back a manager's
  // revocation of a stolen phone.
  fastify.post(
    '/door/devices/:deviceId/reauthorize',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: deviceIdParam, body: scannerDeviceReauthorizeBodySchema }),
        fastify.requirePermission('door.manage'),
      ],
    },
    async (request, reply) => {
      const { deviceId } = request.params as z.infer<typeof deviceIdParam>;
      const body = request.body as z.infer<typeof scannerDeviceReauthorizeBodySchema>;
      const actor = services.actor(request);
      const device = await services.scanner
        .reauthorizeDevice(deviceId, body.deviceName, actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, deviceId, error, { hideForbidden: true }),
        );
      if (device === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        scannerDeviceDtoSchema,
        deviceToDto(device),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door/heartbeat ──────────────────────────────────────────────────
  // "Still here." Authenticated by the session token rather than a device id
  // in the body, so nobody can keep a decommissioned handset looking alive.
  fastify.post(
    '/door/heartbeat',
    {
      preHandler: [
        fastify.rateLimit('SCANNER_COMMAND'),
        fastify.validateV2({
          body: scannerHeartbeatBodySchema,
          headers: scannerSessionTokenHeaderSchema,
        }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof scannerHeartbeatBodySchema>;
      const actor = services.actor(request);
      const device = await services.scanner
        .heartbeat(
          {
            sessionToken: sessionTokenFrom(request),
            eventId: body.eventId,
            ...(body.gate === undefined ? {} : { gate: body.gate }),
          },
          actor,
        )
        .catch((error: unknown) => mapDomainError(reply, request, body.eventId, error));
      if (device === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        scannerDeviceDtoSchema,
        deviceToDto(device),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door/check-ins/confirm ──────────────────────────────────────────
  // Second half of a couple admission. Both seats in one claim, or neither.
  fastify.post(
    '/door/check-ins/confirm',
    {
      preHandler: [
        fastify.rateLimit('SCANNER_COMMAND'),
        fastify.validateV2({
          body: confirmCoupleBodySchema,
          headers: scannerSessionTokenHeaderSchema,
        }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof confirmCoupleBodySchema>;
      const actor = services.actor(request);
      const idempotencyKey =
        typeof request.headers['idempotency-key'] === 'string'
          ? request.headers['idempotency-key']
          : undefined;

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'door.check-in.confirm',
        context: { path: {}, body },
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        run: async () => {
          const outcome: ScanResult = await services.scanner.confirmCouple(
            {
              confirmationToken: body.confirmationToken,
              sessionToken: sessionTokenFrom(request),
              eventId: body.eventId,
              confirmed: body.confirmed,
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
            scanResultToDto(outcome),
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

  // ── POST /door/staff-deny ─────────────────────────────────────────────────
  // Staff refused someone whose ticket scanned fine. The ticket is NOT
  // consumed — the guest did not get in, and burning their entry would turn a
  // door judgement into a refund dispute. Only the refusal is recorded.
  fastify.post(
    '/door/staff-deny',
    {
      preHandler: [
        fastify.rateLimit('SCANNER_COMMAND'),
        fastify.validateV2({
          body: staffDenyBodySchema,
          headers: scannerSessionTokenHeaderSchema,
        }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof staffDenyBodySchema>;
      const actor = services.actor(request);
      const record = await services.scanner
        .recordStaffDeny(
          {
            sessionToken: sessionTokenFrom(request),
            eventId: body.eventId,
            reason: body.reason,
            ...(body.qrPayload === undefined ? {} : { qrPayload: body.qrPayload }),
            ...(body.gate === undefined ? {} : { gate: body.gate }),
          },
          actor,
        )
        .catch((error: unknown) =>
          mapDomainError(reply, request, body.eventId, error, { hideForbidden: true }),
        );
      if (record === undefined) return reply;
      const validated = validateV2Response(reply, request, checkInDtoSchema, checkInToDto(record));
      if (validated === undefined) return reply;
      return reply.status(201).send(validated);
    },
  );

  // ── GET /door/guests ──────────────────────────────────────────────────────
  // The merged roster: online tickets plus tonight's door sales, not-entered
  // first. Status, source and name search are applied SERVER-side and the
  // result is bounded — a festival roster is too much PII, and too much
  // memory, to hand over wholesale to a phone.
  fastify.get(
    '/door/guests',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: doorGuestListQuerySchema }),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof doorGuestListQuerySchema>;
      const actor = services.actor(request);
      const page = await services.doorOps
        .listGuests(
          query.eventId,
          {
            ...(query.status === undefined ? {} : { status: query.status }),
            ...(query.source === undefined ? {} : { source: query.source }),
            ...(query.search === undefined ? {} : { search: query.search }),
            limit: query.limit,
          },
          actor,
        )
        .catch((error: unknown) =>
          mapDomainError(reply, request, query.eventId, error, { hideForbidden: true }),
        );
      if (page === undefined) return reply;
      // Guest names are PII: never cached at the edge or in a shared proxy.
      reply.header('cache-control', 'no-store');
      const validated = validateV2Response(reply, request, doorGuestListResponseSchema, page);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door/guests/check-in ────────────────────────────────────────────
  // Admits a guest whose QR will not scan — cracked screen, dead phone.
  // Deliberately runs the SAME atomic claim as the camera, so this cannot be
  // used to walk past a ticket that is already spent or voided.
  fastify.post(
    '/door/guests/check-in',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: manualCheckInBodySchema }),
        fastify.requirePermission('ticket.override'),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof manualCheckInBodySchema>;
      const actor = services.actor(request);
      const idempotencyKey =
        typeof request.headers['idempotency-key'] === 'string'
          ? request.headers['idempotency-key']
          : undefined;

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'door.guest.check-in',
        context: { path: {}, body },
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        run: async () => {
          const outcome = await services.doorOps.manualCheckIn(
            body.eventId,
            body.entitlementId,
            actor,
          );
          const validated = validateV2Response(reply, request, manualCheckInResponseSchema, {
            guest: outcome.guest,
            checkInId: outcome.scan.id,
          });
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        mapDomainError(reply, request, body.entitlementId, error, { hideForbidden: true }),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── POST /door/wallet-qr ──────────────────────────────────────────────────
  // Reads a guest's cover-wallet tab. Requires a `charge` session: a
  // `scan_only` handset at the entrance must not be able to see, let alone
  // ring up against, someone's bar tab.
  fastify.post(
    '/door/wallet-qr',
    {
      preHandler: [
        fastify.rateLimit('SCANNER_COMMAND'),
        fastify.validateV2({
          body: walletQrResolveBodySchema,
          headers: scannerSessionTokenHeaderSchema,
        }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof walletQrResolveBodySchema>;
      const actor = services.actor(request);
      const view = await services.doorOps
        .resolveWallet(
          {
            sessionToken: sessionTokenFrom(request),
            eventId: body.eventId,
            qrPayload: body.qrPayload,
          },
          actor,
        )
        .catch((error: unknown) =>
          mapDomainError(reply, request, body.eventId, error, { hideForbidden: true }),
        );
      if (view === undefined) return reply;
      // A live balance must never sit in a cache.
      reply.header('cache-control', 'no-store');
      const validated = validateV2Response(reply, request, walletChargeViewSchema, view);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door/wallet-charge ──────────────────────────────────────────────
  // Rings up one preset item. The amount comes from the venue's own price
  // list inside the service; the caller only names an item and a quantity.
  // Idempotent per key, so a retry after a dropped response never double-bills.
  fastify.post(
    '/door/wallet-charge',
    {
      preHandler: [
        fastify.rateLimit('SCANNER_COMMAND'),
        fastify.validateV2({
          body: walletChargeBodySchema,
          headers: scannerSessionTokenHeaderSchema,
        }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof walletChargeBodySchema>;
      const actor = services.actor(request);
      const result = await services.doorOps
        .chargeWallet(
          {
            sessionToken: sessionTokenFrom(request),
            eventId: body.eventId,
            qrPayload: body.qrPayload,
            presetItemId: body.presetItemId,
            quantity: body.quantity,
            idempotencyKey: body.idempotencyKey,
          },
          actor,
        )
        .catch((error: unknown) =>
          mapDomainError(reply, request, body.eventId, error, { hideForbidden: true }),
        );
      if (result === undefined) return reply;
      reply.header('cache-control', 'no-store');
      const validated = validateV2Response(reply, request, walletChargeResponseSchema, result);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── POST /door/ticket-sale ────────────────────────────────────────────────
  // The paid walk-up: pick a tier, take payment, issue real tickets that are
  // already admitted, and settle the revenue through the same writer online
  // sales use. Requires a `full` (door-entry) session — selling entry is a
  // stronger right than scanning it.
  fastify.post(
    '/door/ticket-sale',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          body: doorTicketSaleBodySchema,
          headers: scannerSessionTokenHeaderSchema,
        }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof doorTicketSaleBodySchema>;
      const actor = services.actor(request);
      const sale = await services.doorTicketSale
        .sellAtDoor(
          {
            sessionToken: sessionTokenFrom(request),
            eventId: body.eventId,
            tierId: body.tierId,
            quantity: body.quantity,
            paymentMode: body.paymentMode,
            guestName: body.guestName,
            guestPhone: body.guestPhone ?? null,
            guestEmail: body.guestEmail ?? null,
            guestAge: body.guestAge ?? null,
            gender: body.gender ?? null,
            gate: body.gate ?? null,
            idempotencyKey: body.idempotencyKey,
          },
          actor,
        )
        .catch((error: unknown) =>
          mapDomainError(reply, request, body.eventId, error, { hideForbidden: true }),
        );
      if (sale === undefined) return reply;
      const validated = validateV2Response(reply, request, doorTicketSaleResponseSchema, {
        orderId: sale.order.id,
        amountPaise: sale.amountPaise,
        quantity: body.quantity,
        paymentMode: body.paymentMode,
        ticketIds: sale.tickets.map((t) => t.id),
        checkInIds: sale.checkInIds,
        replayed: sale.replayed,
      });
      if (validated === undefined) return reply;
      return reply.status(sale.replayed ? 200 : 201).send(validated);
    },
  );
}

function deviceToDto(device: ScannerDevice) {
  return {
    id: device.id,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    venueId: device.venueId,
    status: device.status,
    boundAt: device.boundAt,
    unboundAt: device.unboundAt,
    unboundReason: device.unboundReason,
    lastSeenAt: device.lastSeenAt,
    lastEventId: device.lastEventId,
    lastGate: device.lastGate,
    scanCount: device.scanCount,
    lastScanAt: device.lastScanAt,
    lastScanResult: device.lastScanResult,
  };
}
