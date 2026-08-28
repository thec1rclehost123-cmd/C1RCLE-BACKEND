import { buildV2ErrorResponse } from '@c1rcle/contracts';
import {
  opaqueIdSchema,
  doorWalkInRequestSchema,
  doorDineInRequestSchema,
  doorSaleResponseSchema,
  doorSalesListResponseSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { DoorSaleFilters } from '@c1rcle/core/application';
import type { DoorSale } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── V2 door sales slice (Phase 5) ───────────────────────────────────────────
 * Thin routes: validate → build actor → call `DoorService` → serialize to the
 * canonical `doorSaleResponseSchema`. Price is ALWAYS recalculated
 * server-side from the event's ticket catalog inside
 * `DoorService.createWalkIn`/`createDineIn`
 * (`packages/core/src/application/door/door-service.ts`, `catalog.findWalkInTier`
 * / `catalog.findDineInTier`) — the wire contract carries no client price
 * field for exactly this reason.
 *
 * Deliberately a standalone plugin (not folded into `phase5-routes.ts`) so
 * this slice — walk-in, dine-in, sales list — can be built and tested without
 * colliding with the scanner + cover-wallet slices being wired concurrently in
 * that shared file. Registering this plugin into route registration, and
 * leaving `/door/stats` + `/door/stats/ws` as the honest stubs they already
 * are in `phase5-routes.ts`, is owned elsewhere.
 */

const services = createV2Services();

/** Every V2 route resolves its actor off the Better Auth session cookie; the
 * `x-organization-id` header selects which membership is active (see
 * `plugins/auth.ts`'s `onRequest` hook) — same convention as every other v2
 * route, no new device-token auth layer for Phase 5. */
const doorHeaders = z.looseObject({ 'x-organization-id': opaqueIdSchema });

const doorSalesQuerySchema = z
  .object({
    eventId: opaqueIdSchema,
    category: z.enum(['walkin', 'dinein']).optional(),
    status: z.enum(['active', 'voided', 'refunded']).optional(),
    gate: z.string().optional(),
    paymentMode: z.enum(['cash', 'card', 'upi', 'other']).optional(),
    createdBy: opaqueIdSchema.optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();

export default async function phase5DoorSaleRoutes(fastify: FastifyInstance) {
  // ── WALK-IN ───────────────────────────────────────────────────────────────
  fastify.post(
    '/door/walk-in',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: doorWalkInRequestSchema, headers: doorHeaders }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof doorWalkInRequestSchema>;
      const actor = services.actor(request);
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'door.walkin',
        idempotencyKey: body.idempotencyKey,
        context: { path: {}, body },
        run: async () => {
          // Server-side price recalculation happens inside createWalkIn via
          // catalog.findWalkInTier(eventId) — `tierId`/`quantity` on the wire
          // contract are currently NOT consumed by DoorService (single
          // walk-in tier per event drives price regardless of client
          // selection); see task report for this as a flagged gap.
          const sale = await services.door.createWalkIn(
            {
              eventId: body.eventId,
              guestName: body.guestName,
              guestPhone: body.guestPhone ?? undefined,
              guestAge: body.guestAge ?? undefined,
              gender: body.gender ?? undefined,
              contact: body.contact ?? undefined,
              totalGuests: body.totalGuests,
              gate: body.gate ?? undefined,
              paymentMode: body.paymentMode,
              idempotencyKey: body.idempotencyKey,
            },
            actor,
          );
          const validated = validateV2Response(
            reply,
            request,
            doorSaleResponseSchema,
            doorSaleToDto(sale),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, body.eventId, error, {
            conflictId: body.idempotencyKey,
          });
        }
        return mapDomainError(reply, request, body.eventId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── DINE-IN ───────────────────────────────────────────────────────────────
  fastify.post(
    '/door/dine-in',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: doorDineInRequestSchema, headers: doorHeaders }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof doorDineInRequestSchema>;
      const actor = services.actor(request);
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'door.dinein',
        idempotencyKey: body.idempotencyKey,
        context: { path: {}, body },
        run: async () => {
          // Same server-side recalculation as walk-in, via
          // catalog.findDineInTier(eventId).
          const sale = await services.door.createDineIn(
            {
              eventId: body.eventId,
              guestName: body.guestName,
              guestPhone: body.guestPhone ?? undefined,
              guestAge: body.guestAge ?? undefined,
              gender: body.gender ?? undefined,
              contact: body.contact ?? undefined,
              totalGuests: body.totalGuests,
              // CreateDineInInput.tableNumber is a required `string` even
              // though the wire contract and the persisted sale both treat
              // it as optional/nullable — see task report gap note.
              tableNumber: body.tableNumber ?? '',
              gate: body.gate ?? undefined,
              paymentMode: body.paymentMode,
              idempotencyKey: body.idempotencyKey,
            },
            actor,
          );
          const validated = validateV2Response(
            reply,
            request,
            doorSaleResponseSchema,
            doorSaleToDto(sale),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, body.eventId, error, {
            conflictId: body.idempotencyKey,
          });
        }
        return mapDomainError(reply, request, body.eventId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── SALES LIST ────────────────────────────────────────────────────────────
  fastify.get(
    '/door/sales',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: doorSalesQuerySchema, headers: doorHeaders }),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof doorSalesQuerySchema>;
      const actor = services.actor(request);
      const filters: DoorSaleFilters = {};
      if (query.category) filters.category = query.category;
      if (query.status) filters.status = query.status;
      if (query.gate) filters.gate = query.gate;
      if (query.paymentMode) filters.paymentMode = query.paymentMode;
      if (query.createdBy) filters.createdBy = query.createdBy;
      if (query.from) filters.from = new Date(query.from);
      if (query.to) filters.to = new Date(query.to);
      const sales = await services.door
        .listSales(query.eventId, actor, filters)
        .catch((error: unknown) =>
          mapDomainError(reply, request, query.eventId, error, { hideForbidden: true }),
        );
      if (sales === undefined) return reply;
      // DoorService.listSales has no cursor pagination — it fetches up to
      // 1000 sales for the event and filters in memory. `limit` here is an
      // honest client-side slice of that result, not a real page cursor.
      const limited = query.limit ? sales.slice(0, query.limit) : sales;
      const items = limited.map(doorSaleToDto);
      const payload = {
        items,
        pageInfo: {
          page: 1,
          pageSize: query.limit ?? items.length,
          total: sales.length,
          hasNextPage: limited.length < sales.length,
        },
      };
      const validated = validateV2Response(reply, request, doorSalesListResponseSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}

/** Converts the core domain DoorSale to the canonical wire DTO. */
export function doorSaleToDto(sale: DoorSale) {
  return {
    id: sale.id,
    eventId: sale.eventId,
    category: sale.category,
    guestName: sale.guestName,
    totalGuests: sale.totalGuests,
    amountPaise: sale.amountPaise,
    paymentMode: sale.paymentMode,
    status: sale.status,
    createdAt: sale.createdAt,
  };
}

/**
 * Maps core domain errors to the V2 error envelope; returns `undefined` after
 * sending. Local copy per the Phase 5 wiring plan's point 4: the shared
 * `plugins/error-handler.ts`'s `mapDomainError` only maps specific
 * `*NotFoundError` subclasses (e.g. `event_not_found`) to 404 — not the
 * generic `NotFoundError` (`code: 'not_found'`) that `DoorService` throws
 * throughout (`NotFoundError('Event', ...)`, `NotFoundError('Door sale', ...)`
 * — see `packages/core/src/domain/errors.ts`). Falling through to the shared
 * handler for those would produce an unlogged 500 instead of a 404, so this
 * route-level copy adds `'not_found'` as a first-class branch.
 */
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
  const notFoundCodes = new Set(['not_found']);
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
  // Anything else is a genuine bug — log it rather than silently 500ing.
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
