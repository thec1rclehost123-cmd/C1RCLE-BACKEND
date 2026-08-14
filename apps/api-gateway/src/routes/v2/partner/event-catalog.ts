import {
  opaqueIdSchema,
  idempotencyKeySchema,
  paginationQuerySchema,
  ticketTierDtoSchema,
  createTicketTierSchema,
  promoCodeDtoSchema,
  createPromoCodeSchema,
  tablePackageDtoSchema,
  createTablePackageSchema,
  promoterAssignmentDtoSchema,
  assignPromoterSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { PromoCode, PromoterAssignment, TablePackage, TicketTier } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 event-catalog slice (Phase 3) ────────────────────────────────────────
 *
 * Tiers, promo codes, table packages and promoter assignments. `task.md` listed
 * event-catalog *writes* as BLOCKED for the Phase 0 slice specifically because
 * no routes existed — `EventCatalogService` has been there and tested all
 * along. These are thin routes over it, nothing more.
 *
 * Everything is scoped through the service's own `assertEventOwned`, so a
 * cross-tenant event id reads as not-found rather than confirming it exists.
 */

const services = createV2Services();

const eventIdParam = z.object({ eventId: opaqueIdSchema });
const assignmentIdParam = z.object({ assignmentId: opaqueIdSchema });

const readHeaders = z.looseObject({ 'x-organization-id': opaqueIdSchema });
const commandHeaders = readHeaders.extend({ 'idempotency-key': idempotencyKeySchema });

const tierListSchema = z.array(ticketTierDtoSchema);
const promoListSchema = paginatedSchema(promoCodeDtoSchema);
const tableListSchema = z.array(tablePackageDtoSchema);
const assignmentListSchema = z.array(promoterAssignmentDtoSchema);

/**
 * Default commission when a caller supplies no terms. Matches v1's
 * `promoter-engine` fallback (15%) so a migrated event behaves identically.
 */
const DEFAULT_COMMISSION_RATE_PERCENT = 15;

export default async function partnerEventCatalogRoutes(fastify: FastifyInstance) {
  // ── TICKET TIERS ──────────────────────────────────────────────────────────
  fastify.get(
    '/events/:eventId/ticket-tiers',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: eventIdParam, headers: readHeaders }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const actor = services.actor(request);
      const tiers = await services.catalog
        .listTiers(actor, eventId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (tiers === undefined) return reply;

      const validated = validateV2Response(reply, request, tierListSchema, tiers.map(tierToDto));
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/events/:eventId/ticket-tiers',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: eventIdParam,
          headers: commandHeaders,
          body: createTicketTierSchema,
        }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const body = request.body as z.infer<typeof createTicketTierSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'event-ticket-tiers.create',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { eventId }, body },
        run: async () => {
          const tier = await services.catalog.createTier(actor, { eventId, ...body });
          const validated = validateV2Response(
            reply,
            request,
            ticketTierDtoSchema,
            tierToDto(tier),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, eventId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, eventId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── PROMO CODES ───────────────────────────────────────────────────────────
  fastify.get(
    '/events/:eventId/promo-codes',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: eventIdParam,
          querystring: paginationQuerySchema,
          headers: readHeaders,
        }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.catalog
        .listPromotions(actor, eventId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (page === undefined) return reply;

      const payload = {
        items: page.items.map(promoToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, promoListSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/events/:eventId/promo-codes',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: eventIdParam,
          headers: commandHeaders,
          body: createPromoCodeSchema,
        }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const body = request.body as z.infer<typeof createPromoCodeSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'event-promo-codes.create',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { eventId }, body },
        run: async () => {
          const promo = await services.catalog.createPromotion(actor, { eventId, ...body });
          const validated = validateV2Response(
            reply,
            request,
            promoCodeDtoSchema,
            promoToDto(promo),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, eventId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, eventId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── TABLE PACKAGES ────────────────────────────────────────────────────────
  fastify.get(
    '/events/:eventId/table-packages',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: eventIdParam, headers: readHeaders }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const actor = services.actor(request);
      const tables = await services.catalog
        .listTables(actor, eventId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (tables === undefined) return reply;

      const validated = validateV2Response(reply, request, tableListSchema, tables.map(tableToDto));
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/events/:eventId/table-packages',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: eventIdParam,
          headers: commandHeaders,
          body: createTablePackageSchema,
        }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const body = request.body as z.infer<typeof createTablePackageSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'event-table-packages.create',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { eventId }, body },
        run: async () => {
          const table = await services.catalog.createTable(actor, { eventId, ...body });
          const validated = validateV2Response(
            reply,
            request,
            tablePackageDtoSchema,
            tableToDto(table),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, eventId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, eventId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── PROMOTER ASSIGNMENTS ──────────────────────────────────────────────────
  fastify.get(
    '/events/:eventId/promoter-assignments',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: eventIdParam, headers: readHeaders }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const actor = services.actor(request);
      const assignments = await services.catalog
        .listAssignments(actor, eventId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (assignments === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        assignmentListSchema,
        assignments.map(assignmentToDto),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/events/:eventId/promoter-assignments',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: eventIdParam,
          headers: commandHeaders,
          body: assignPromoterSchema,
        }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const body = request.body as z.infer<typeof assignPromoterSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'event-promoter-assignments.create',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { eventId }, body },
        run: async () => {
          const assignment = await services.catalog.assignPromoter(actor, {
            eventId,
            promoterId: body.promoterId,
            // Terms are frozen into the assignment at creation, so a later
            // rate change never rewrites what a past order earned.
            term: {
              version: 1,
              ratePercent: body.ratePercent ?? DEFAULT_COMMISSION_RATE_PERCENT,
              flatPaise: body.flatPaise ?? 0,
            },
          });
          const validated = validateV2Response(
            reply,
            request,
            promoterAssignmentDtoSchema,
            assignmentToDto(assignment),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, eventId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, eventId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // Ending an assignment is a POST, not a DELETE: the row survives as the
  // record of what a promoter earned while they were assigned.
  fastify.post(
    '/promoter-assignments/:assignmentId/end',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: assignmentIdParam, headers: commandHeaders }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      const { assignmentId } = request.params as z.infer<typeof assignmentIdParam>;
      const actor = services.actor(request);
      const assignment = await services.catalog
        .endAssignment(actor, assignmentId)
        .catch((error: unknown) => mapDomainError(reply, request, assignmentId, error));
      if (assignment === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        promoterAssignmentDtoSchema,
        assignmentToDto(assignment),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}

/* ─── Serializers ──────────────────────────────────────────────────────────── */

function tierToDto(tier: TicketTier) {
  return {
    id: tier.id,
    eventId: tier.eventId,
    organizationId: tier.organizationId,
    name: tier.name,
    description: tier.description,
    entryType: tier.entryType,
    currency: tier.currency,
    priceInPaise: tier.priceInPaise,
    quantity: tier.quantity,
    status: tier.status,
    salesStartAt: tier.salesStartAt,
    salesEndAt: tier.salesEndAt,
    minPerOrder: tier.minPerOrder,
    maxPerOrder: tier.maxPerOrder,
    version: tier.version,
    createdAt: tier.createdAt,
    updatedAt: tier.updatedAt,
  };
}

function promoToDto(promo: PromoCode) {
  return {
    id: promo.id,
    eventId: promo.eventId,
    organizationId: promo.organizationId,
    code: promo.code,
    name: promo.name,
    type: promo.type,
    discountType: promo.discountType,
    discountValue: promo.discountValue,
    tierIds: [...promo.tierIds],
    maxRedemptions: promo.maxRedemptions,
    maxPerUser: promo.maxPerUser,
    redemptionCount: promo.redemptionCount,
    startsAt: promo.startsAt,
    endsAt: promo.endsAt,
    isActive: promo.isActive,
    version: promo.version,
    createdAt: promo.createdAt,
    updatedAt: promo.updatedAt,
  };
}

function tableToDto(table: TablePackage) {
  return {
    id: table.id,
    eventId: table.eventId,
    organizationId: table.organizationId,
    name: table.name,
    capacity: table.capacity,
    pricePaise: table.pricePaise,
    minSpendPaise: table.minSpendPaise,
    isActive: table.isActive,
    version: table.version,
    createdAt: table.createdAt,
    updatedAt: table.updatedAt,
  };
}

function assignmentToDto(assignment: PromoterAssignment) {
  return {
    id: assignment.id,
    eventId: assignment.eventId,
    promoterId: assignment.promoterId,
    status: assignment.status,
    terms: assignment.terms,
    endedAt: assignment.endedAt,
    version: assignment.version,
    createdAt: assignment.createdAt,
    updatedAt: assignment.updatedAt,
  };
}
