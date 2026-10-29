import {
  opaqueIdSchema,
  idempotencyKeySchema,
  paginationQuerySchema,
  ticketTierDtoSchema,
  createTicketTierSchema,
  ticketAddonDtoSchema,
  ticketAddonListResponseSchema,
  createTicketAddonSchema,
  promoCodeDtoSchema,
  createPromoCodeSchema,
  tablePackageDtoSchema,
  createTablePackageSchema,
  promoterAssignmentDtoSchema,
  promoterAssignmentCandidateDtoSchema,
  promoterAssignmentActionSchema,
  promoterAssignmentRevokeSchema,
  assignPromoterSchema,
  paginatedSchema,
  createTicketAccessCodeSchema,
  createTicketAccessInvitationSchema,
  ticketAccessCodeCreateResponseSchema,
  ticketAccessCodeDtoSchema,
  ticketAccessCodeListResponseSchema,
  proposeEventCoverPolicySchema,
  eventCoverPolicyProposalDtoSchema,
  eventCoverPolicyAcceptanceDtoSchema,
  eventCoverPolicyHistoryDtoSchema,
} from '@c1rcle/contracts/client';
import { promoterAssignmentStatusAt } from '@c1rcle/core/domain';
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
const ticketAddonListSchema = ticketAddonListResponseSchema;
const promoListSchema = paginatedSchema(promoCodeDtoSchema);
const tableListSchema = z.array(tablePackageDtoSchema);
const assignmentListSchema = z.array(promoterAssignmentDtoSchema);
const assignmentCandidatesSchema = z.array(promoterAssignmentCandidateDtoSchema);
const accessCodeIdParam = eventIdParam.extend({ codeId: opaqueIdSchema });

/**
 * Default commission when a caller supplies no terms. Matches v1's
 * `promoter-engine` fallback (15%) so a migrated event behaves identically.
 */
const DEFAULT_COMMISSION_RATE_PERCENT = 15;

export default async function partnerEventCatalogRoutes(fastify: FastifyInstance) {
  // ── VERSIONED EVENT-COVER POLICY ──────────────────────────────────────────
  fastify.get(
    '/events/:eventId/cover-policy',
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
      const history = await services.eventCoverPolicies
        .listForEvent(services.actor(request), eventId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (history === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        eventCoverPolicyHistoryDtoSchema,
        history,
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/events/:eventId/cover-policy',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: eventIdParam,
          headers: commandHeaders,
          body: proposeEventCoverPolicySchema,
        }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const body = request.body as z.infer<typeof proposeEventCoverPolicySchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'event-cover-policy.propose',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { eventId }, body },
        run: async () => {
          const proposal = await services.eventCoverPolicies.propose(
            actor,
            eventId,
            body.policyVersion,
            body.terms,
          );
          const validated = validateV2Response(
            reply,
            request,
            eventCoverPolicyProposalDtoSchema,
            proposal,
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, eventId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.post(
    '/events/:eventId/cover-policy/:proposalId/accept',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: eventIdParam.extend({ proposalId: opaqueIdSchema }),
          headers: commandHeaders,
          body: z.object({}).strict(),
        }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      const { eventId, proposalId } = request.params as {
        eventId: string;
        proposalId: string;
      };
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'event-cover-policy.accept',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { eventId, proposalId }, body: {} },
        run: async () => {
          const acceptance = await services.eventCoverPolicies.accept(actor, eventId, proposalId);
          const validated = validateV2Response(
            reply,
            request,
            eventCoverPolicyAcceptanceDtoSchema,
            acceptance,
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, eventId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── PRIVATE TIER ACCESS CODES ─────────────────────────────────────────────
  fastify.get(
    '/events/:eventId/access-codes',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: eventIdParam,
          headers: readHeaders,
          querystring: paginationQuerySchema,
        }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const page = await services.ticketAccess
        .listCodes(services.actor(request), eventId, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        })
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (page === undefined) return reply;
      const payload = {
        items: page.items.map(accessCodeToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(
        reply,
        request,
        ticketAccessCodeListResponseSchema,
        payload,
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/events/:eventId/access-codes',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: eventIdParam,
          headers: readHeaders,
          body: createTicketAccessCodeSchema,
        }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const body = request.body as z.infer<typeof createTicketAccessCodeSchema>;
      const result = await services.ticketAccess
        .createCode(services.actor(request), { eventId, ...body })
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (result === undefined) return reply;
      const validated = validateV2Response(reply, request, ticketAccessCodeCreateResponseSchema, {
        code: result.code,
        accessCode: accessCodeToDto(result.accessCode),
      });
      if (validated === undefined) return reply;
      return reply.status(201).send(validated);
    },
  );

  fastify.post(
    '/events/:eventId/access-invitations',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: eventIdParam,
          headers: readHeaders,
          body: createTicketAccessInvitationSchema,
        }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const body = request.body as z.infer<typeof createTicketAccessInvitationSchema>;
      const result = await services.ticketAccess
        .createInvitation(services.actor(request), { eventId, ...body })
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (result === undefined) return reply;
      const validated = validateV2Response(reply, request, ticketAccessCodeCreateResponseSchema, {
        code: result.code,
        accessCode: accessCodeToDto(result.accessCode),
      });
      if (validated === undefined) return reply;
      return reply.status(201).send(validated);
    },
  );

  fastify.post(
    '/events/:eventId/access-codes/:codeId/revoke',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: accessCodeIdParam,
          headers: readHeaders,
          body: z.object({ reason: z.string().trim().min(8).max(500) }).strict(),
        }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      const { eventId, codeId } = request.params as z.infer<typeof accessCodeIdParam>;
      const { reason } = request.body as { reason: string };
      const accessCode = await services.ticketAccess
        .revokeCode(services.actor(request), eventId, codeId, reason)
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (accessCode === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        ticketAccessCodeDtoSchema,
        accessCodeToDto(accessCode),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/events/:eventId/promoter-candidates',
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
      const candidates = await services.catalog
        .listEligiblePromoters(actor, eventId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (candidates === undefined) return reply;
      const validated = validateV2Response(reply, request, assignmentCandidatesSchema, candidates);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

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
      reply.header('cache-control', 'private, no-store');
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

  // ── NON-COVER TICKET ADD-ONS ─────────────────────────────────────────────
  fastify.get(
    '/events/:eventId/ticket-addons',
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
      const addons = await services.catalog
        .listTicketAddons(services.actor(request), eventId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (addons === undefined) return reply;
      const validated = validateV2Response(reply, request, ticketAddonListSchema, {
        items: addons,
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/events/:eventId/ticket-addons',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: eventIdParam,
          headers: commandHeaders,
          body: createTicketAddonSchema,
        }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const body = request.body as z.infer<typeof createTicketAddonSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'event-ticket-addons.create',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { eventId }, body },
        run: async () => {
          const addon = await services.catalog.createTicketAddon(actor, { eventId, ...body });
          const validated = validateV2Response(reply, request, ticketAddonDtoSchema, addon);
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
      reply.header('cache-control', 'private, no-store');
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
      reply.header('cache-control', 'private, no-store');
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
      reply.header('cache-control', 'private, no-store');
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
              ...(body.tierRates ? { tierRates: body.tierRates } : {}),
            },
            startsAt: body.startsAt,
            expiresAt: body.expiresAt,
            eligibleTierIds: body.eligibleTierIds,
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

  fastify.post(
    '/promoter-assignments/:assignmentId/revoke',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: assignmentIdParam,
          headers: commandHeaders,
          body: promoterAssignmentRevokeSchema,
        }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      const { assignmentId } = request.params as z.infer<typeof assignmentIdParam>;
      const body = request.body as z.infer<typeof promoterAssignmentRevokeSchema>;
      const actor = services.actor(request);
      const headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'event-promoter-assignment.revoke',
        idempotencyKey: headers['idempotency-key'],
        context: { path: { assignmentId }, body },
        run: async () => {
          const assignment = await services.catalog.revokeAssignment(
            actor,
            assignmentId,
            body.expectedVersion,
            body.reason,
          );
          const validated = validateV2Response(
            reply,
            request,
            promoterAssignmentDtoSchema,
            assignmentToDto(assignment),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, assignmentId, error, {
              conflictId: headers['idempotency-key'],
            })
          : mapDomainError(reply, request, assignmentId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.post(
    '/promoter-assignments/:assignmentId/respond',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: assignmentIdParam,
          headers: commandHeaders,
          body: promoterAssignmentActionSchema,
        }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      const { assignmentId } = request.params as z.infer<typeof assignmentIdParam>;
      const body = request.body as z.infer<typeof promoterAssignmentActionSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'event-promoter-assignment.respond',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { assignmentId }, body },
        run: async () => {
          const assignment = await services.catalog.respondToAssignment(
            actor,
            assignmentId,
            body.decision,
            body.expectedVersion,
          );
          const validated = validateV2Response(
            reply,
            request,
            promoterAssignmentDtoSchema,
            assignmentToDto(assignment),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, assignmentId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, assignmentId, error),
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
    coverAmountPaise: tier.coverAmountPaise,
    quantity: tier.quantity,
    status: tier.status,
    salesStartAt: tier.salesStartAt,
    salesEndAt: tier.salesEndAt,
    maxPerOrder: tier.maxPerOrder,
    accessMode: tier.accessMode ?? 'public',
    accessType: tier.accessType,
    audienceType: tier.audienceType,
    guestCount: tier.guestCount,
    admissionMode: tier.admissionMode,
    pricingPhases: tier.pricingPhases,
    doorPriceInPaise: tier.doorPriceInPaise,
    benefits: tier.benefits,
    minAge: tier.minAge,
    maxAge: tier.maxAge,
    minPerOrder: tier.minPerOrder,
    maxPerUser: tier.maxPerUser,
    tableConfig: tier.tableConfig,
    commissionEligible: tier.commissionEligible,
    version: tier.version,
    createdAt: tier.createdAt,
    updatedAt: tier.updatedAt,
  };
}

function accessCodeToDto(code: {
  id: string;
  kind: 'code' | 'invitation';
  scope?: 'tiers' | 'event';
  eventId: string;
  tierIds: string[];
  status: 'active' | 'revoked';
  startsAt: string;
  expiresAt: string;
  maxRedemptions: number;
  redemptionCount: number;
  revokedAt: string | null;
  revokedReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: code.id,
    kind: code.kind,
    scope: code.scope ?? 'tiers',
    eventId: code.eventId,
    tierIds: [...code.tierIds],
    status: code.status,
    startsAt: code.startsAt,
    expiresAt: code.expiresAt,
    maxRedemptions: code.maxRedemptions,
    redemptionCount: code.redemptionCount,
    revokedAt: code.revokedAt,
    revokedReason: code.revokedReason,
    version: code.version,
    createdAt: code.createdAt,
    updatedAt: code.updatedAt,
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
    discountFundingOwner: promo.discountFundingOwner,
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
  };
}
