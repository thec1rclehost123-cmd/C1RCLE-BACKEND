import {
  opaqueIdSchema,
  idempotencyKeySchema,
  paginationQuerySchema,
  referralLinkDtoSchema,
  promoterReferralLinkListResponseSchema,
  promoterCampaignSummaryDtoSchema,
  promoterAttributedOrderListResponseSchema,
  createReferralLinkSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Order, ReferralLink } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Promoter referral links (Phase 1) ───────────────────────────────────────
 *
 * The partner-side surface: create, list and deactivate. The guest-side click
 * tracker belongs to Phase 4's public routes — a click is anonymous traffic,
 * not a partner action, and mixing it in here would put an unauthenticated
 * endpoint behind partner policy.
 */

const services = createV2Services();

const eventIdParam = z.object({ eventId: opaqueIdSchema });
const linkIdParam = z.object({ referralLinkId: opaqueIdSchema });
const assignmentIdParam = z.object({ assignmentId: opaqueIdSchema });
const promoterIdParam = z.object({ promoterId: opaqueIdSchema });
const eventPromoterParam = z.object({ eventId: opaqueIdSchema, promoterId: opaqueIdSchema });

const readHeaders = z.looseObject({ 'x-organization-id': opaqueIdSchema });
const commandHeaders = readHeaders.extend({ 'idempotency-key': idempotencyKeySchema });

const linkListSchema = paginatedSchema(referralLinkDtoSchema);
const referralLinkPaginationQuerySchema = paginationQuerySchema
  .extend({
    cursor: z
      .string()
      .regex(/^\d+$/u)
      .refine((value) => Number.isSafeInteger(Number(value)))
      .optional(),
  })
  .refine(({ cursor, limit }) => cursor === undefined || Number(cursor) % limit === 0);
const promoterCreateLinkSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    code: z
      .string()
      .min(4)
      .max(16)
      .regex(/^[A-Za-z0-9 -]+$/)
      .optional(),
    vanitySlug: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z0-9 -]+$/)
      .optional(),
  })
  .strict();
const eventAttributedOrdersQuerySchema = paginationQuerySchema.extend({
  cursor: z.string().regex(/^\d+$/u).optional(),
});

function attributedOrderToDto(order: Order) {
  const attribution = order.attribution;
  if (!attribution) throw new Error('Promoter order query returned an unattributed order');
  return {
    id: order.id,
    bookingReference: order.bookingReference ?? null,
    eventId: order.eventId,
    status: order.status,
    ticketCount: order.lines.reduce((sum, line) => sum + line.quantity, 0),
    attributedTicketValuePaise: order.discountedSubtotalPaise,
    promoterCommissionPaise: attribution.promoterCommissionPaise,
    attributedAt: attribution.attributedAt,
  };
}

export default async function partnerReferralLinkRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/events/:eventId/promoters/:promoterId/attributed-orders',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: eventPromoterParam,
          querystring: eventAttributedOrdersQuerySchema,
          headers: readHeaders,
        }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      const { eventId, promoterId } = request.params as z.infer<typeof eventPromoterParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.referralLinks
        .listAttributedOrdersForEvent(actor, eventId, promoterId, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        })
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (page === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        promoterAttributedOrderListResponseSchema,
        {
          items: page.items.map(attributedOrderToDto),
          pageInfo: {
            page: Math.floor((Number.parseInt(query.cursor ?? '0', 10) || 0) / query.limit) + 1,
            pageSize: query.limit,
            total: page.total,
            hasNextPage: page.nextCursor !== null,
          },
        },
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/promoters/:promoterId/attributed-orders',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: promoterIdParam,
          querystring: paginationQuerySchema,
          headers: readHeaders,
        }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      const { promoterId } = request.params as z.infer<typeof promoterIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.referralLinks
        .listAttributedOrders(actor, promoterId, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        })
        .catch((error: unknown) =>
          mapDomainError(reply, request, promoterId, error, { hideForbidden: true }),
        );
      if (page === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        promoterAttributedOrderListResponseSchema,
        {
          items: page.items.map(attributedOrderToDto),
          pageInfo: {
            page: 1,
            pageSize: query.limit,
            total: page.total,
            hasNextPage: page.nextCursor !== null,
          },
        },
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/promoters/:promoterId/campaign-summary',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: promoterIdParam, headers: readHeaders }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      const { promoterId } = request.params as z.infer<typeof promoterIdParam>;
      const actor = services.actor(request);
      const summary = await services.referralLinks
        .getCampaignSummary(actor, promoterId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, promoterId, error, { hideForbidden: true }),
        );
      if (summary === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        promoterCampaignSummaryDtoSchema,
        summary,
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/promoters/:promoterId/referral-links',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: promoterIdParam,
          querystring: referralLinkPaginationQuerySchema,
          headers: readHeaders,
        }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      const { promoterId } = request.params as z.infer<typeof promoterIdParam>;
      const query = request.query as z.infer<typeof referralLinkPaginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.referralLinks
        .listForPromoter(actor, promoterId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) =>
          mapDomainError(reply, request, promoterId, error, { hideForbidden: true }),
        );
      if (page === undefined) return reply;
      const validated = validateV2Response(reply, request, promoterReferralLinkListResponseSchema, {
        items: page.items.map(linkToDto),
        pageInfo: {
          page: Math.floor((Number.parseInt(query.cursor ?? '0', 10) || 0) / query.limit) + 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
          nextCursor: page.nextCursor,
        },
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/promoter-assignments/:assignmentId/referral-links',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: assignmentIdParam,
          headers: commandHeaders,
          body: promoterCreateLinkSchema,
        }),
        // The service applies the tighter boundary: active assignment belongs
        // to the caller's promoter organization.
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      const { assignmentId } = request.params as z.infer<typeof assignmentIdParam>;
      const body = request.body as z.infer<typeof promoterCreateLinkSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'promoter-assignment.referral-link.create',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { assignmentId }, body },
        run: async () => {
          const link = await services.referralLinks.createForAssignment(
            actor,
            assignmentId,
            body.label,
            body.code,
            body.vanitySlug,
          );
          const validated = validateV2Response(
            reply,
            request,
            referralLinkDtoSchema,
            linkToDto(link),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
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

  fastify.get(
    '/events/:eventId/referral-links',
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
      const page = await services.referralLinks
        .listForEvent(actor, eventId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (page === undefined) return reply;

      const payload = {
        items: page.items.map(linkToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, linkListSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/events/:eventId/referral-links',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: eventIdParam,
          headers: commandHeaders,
          body: createReferralLinkSchema,
        }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const body = request.body as z.infer<typeof createReferralLinkSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'referral-links.create',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { eventId }, body },
        run: async () => {
          const link = await services.referralLinks.create(actor, {
            eventId,
            promoterId: body.promoterId,
            code: body.code,
            label: body.label,
          });
          const validated = validateV2Response(
            reply,
            request,
            referralLinkDtoSchema,
            linkToDto(link),
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

  // Deactivation, not deletion: a link that stops attributing new orders must
  // still exist so past attributions remain explicable.
  fastify.post(
    '/referral-links/:referralLinkId/deactivate',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: linkIdParam, headers: commandHeaders }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      const { referralLinkId } = request.params as z.infer<typeof linkIdParam>;
      const actor = services.actor(request);
      const headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'referral-link.deactivate',
        idempotencyKey: headers['idempotency-key'],
        context: { path: { referralLinkId }, body: {} },
        run: async () => {
          const link = await services.referralLinks.deactivate(actor, referralLinkId);
          const validated = validateV2Response(
            reply,
            request,
            referralLinkDtoSchema,
            linkToDto(link),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, referralLinkId, error, {
              conflictId: headers['idempotency-key'],
            })
          : mapDomainError(reply, request, referralLinkId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}

function linkToDto(link: ReferralLink) {
  return {
    id: link.id,
    eventId: link.eventId,
    promoterId: link.promoterId,
    organizationId: link.organizationId,
    assignmentId: link.assignmentId,
    assignmentVersion: link.assignmentVersion,
    termsSnapshot: link.termsSnapshot,
    commissionPolicyVersion: link.commissionPolicyVersion,
    commercialPolicyVersion: link.commercialPolicyVersion,
    eligibleTierIds: link.eligibleTierIds,
    attributionSignature: link.attributionSignature,
    eventTitle: link.eventTitle,
    campaignLabel: link.campaignLabel,
    vanityPrefix: link.vanityPrefix,
    vanitySlug: link.vanitySlug,
    code: link.code,
    label: link.label,
    isActive: link.isActive,
    clicks: link.clicks,
    lastClickedAt: link.lastClickedAt ?? null,
    conversions: link.conversions,
    revenuePaise: link.revenuePaise,
    commissionPaise: link.commissionPaise,
    version: link.version,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}
