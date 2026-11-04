import {
  adminPromoterAssignmentListResponseSchema,
  adminPromoterActionResponseSchema,
  adminPromoterReferralLinkListResponseSchema,
  adminPromoterRiskFlagsResponseSchema,
  adminPromoterReferralLinkActionResponseSchema,
  adminPromoterSuspendRequestSchema,
  idempotencyKeySchema,
  opaqueIdSchema,
  paginationQuerySchema,
} from '@c1rcle/contracts/client';
import { promoterAssignmentStatusAt } from '@c1rcle/core/domain';
import { z } from 'zod';

import type { PromoterAssignment, ReferralLink } from '@c1rcle/core/domain';

import { csvEscape } from '../../../lib/csv.js';
import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { requestMeta } from '../../../lib/v2-request-meta.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin promoters desk (Phase 7 admin) ────────────────────────────────────
 * V2 has no standalone "promoter" entity — a promoter is an `Organization`
 * member with a versioned commission assignment per event
 * (`PromoterAssignment`). Platform-wide listing (read-only) plus
 * lifecycle actions (suspend / reinstate) for the admin `/promoters`
 * dashboard.
 *
 * `PROMOTER_SUSPEND`/`PROMOTER_REINSTATE` are TIER2 direct commands (same
 * idempotent, before/after-audited shape as venue suspend/reinstate): all of
 * a promoter user's assignments are bulk-transitioned, and a no-op repeat
 * returns 200 with `affectedAssignments: 0`.
 */

const services = createV2Services();

const promotersQuerySchema = paginationQuerySchema;
const promoterLinksResponseSchema = adminPromoterReferralLinkListResponseSchema;
const promoterIdParam = z.object({ promoterId: opaqueIdSchema });
const promoterLinkIdParam = z.object({ linkId: opaqueIdSchema });
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });

function listResponse<T>(items: T[], total: number, limit: number, nextCursor: string | null) {
  return {
    items,
    pageInfo: {
      page: 1,
      pageSize: limit,
      total,
      hasNextPage: nextCursor !== null,
    },
  };
}

function assignmentToDto(assignment: PromoterAssignment) {
  return {
    id: assignment.id,
    eventId: assignment.eventId,
    promoterId: assignment.promoterId,
    status: promoterAssignmentStatusAt(assignment, services.config().clock.now()),
    ratePercent: assignment.terms.ratePercent,
    flatPaise: assignment.terms.flatPaise,
    termsVersion: assignment.terms.version,
    ...(assignment.terms.tierRates ? { tierRates: assignment.terms.tierRates } : {}),
    startsAt: assignment.startsAt,
    expiresAt: assignment.expiresAt,
    eligibleTierIds: assignment.eligibleTierIds,
    createdAt: assignment.createdAt,
    invitedAt: assignment.invitedAt,
    invitedBy: assignment.invitedBy,
    acceptedAt: assignment.acceptedAt,
    respondedBy: assignment.respondedBy,
    endedAt: assignment.endedAt,
    revokedAt: assignment.revokedAt,
    revokedBy: assignment.revokedBy,
    revocationReason: assignment.revocationReason,
    suspendedAt: assignment.suspendedAt,
  };
}

function referralLinkToDto(link: ReferralLink) {
  return {
    id: link.id,
    eventId: link.eventId,
    assignmentId: link.assignmentId,
    eventTitle: link.eventTitle,
    code: link.code,
    label: link.label,
    isActive: link.isActive,
    clicks: link.clicks,
    lastClickedAt: link.lastClickedAt ?? null,
    conversions: link.conversions,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

export default async function adminPromotersRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/admin/promoter-links/:linkId/deactivate',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: promoterLinkIdParam,
          headers: commandHeaders,
          body: adminPromoterSuspendRequestSchema,
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { linkId } = request.params as z.infer<typeof promoterLinkIdParam>;
      const { reason } = request.body as z.infer<typeof adminPromoterSuspendRequestSchema>;
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.promoter-link.deactivate',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { linkId }, body: { reason } },
        run: async () => {
          const outcome = await services.adminOps.deactivatePromoterReferralLink(
            userId,
            linkId,
            reason,
            requestMeta(request),
          );
          const validated = validateV2Response(
            reply,
            request,
            adminPromoterReferralLinkActionResponseSchema,
            {
              linkId,
              action: 'deactivated',
              changed: outcome.changed,
              at: outcome.at.toISOString(),
            },
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, linkId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, linkId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.get(
    '/admin/promoters/:promoterId/referral-links',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: promoterIdParam, querystring: promotersQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { promoterId } = request.params as z.infer<typeof promoterIdParam>;
      const query = request.query as z.infer<typeof promotersQuerySchema>;
      const page = await services.adminOps
        .listPromoterReferralLinks(userId, promoterId, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;
      const validated = validateV2Response(reply, request, promoterLinksResponseSchema, {
        items: page.items.map(referralLinkToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/admin/promoters/:promoterId/risk-flags',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: promoterIdParam })],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { promoterId } = request.params as z.infer<typeof promoterIdParam>;
      const result = await services.adminOps
        .listPromoterRiskFlags(userId, promoterId)
        .catch((error: unknown) => mapDomainError(reply, request, promoterId, error));
      if (result === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        adminPromoterRiskFlagsResponseSchema,
        result,
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/admin/promoters',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: promotersQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof promotersQuerySchema>;

      const page = await services.adminOps
        .listPromoterAssignments(userId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        adminPromoterAssignmentListResponseSchema,
        listResponse(page.items.map(assignmentToDto), page.total, query.limit, page.nextCursor),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/admin/promoters/export.csv',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({})],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;

      const page = await services.adminOps
        .listPromoterAssignments(userId, { limit: 1000, cursor: null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const header = [
        'id',
        'promoterId',
        'eventId',
        'status',
        'ratePercent',
        'flatPaise',
        'createdAt',
      ];
      const lines = page.items.map((assignment) => {
        const dto = assignmentToDto(assignment);
        return [
          csvEscape(dto.id),
          csvEscape(dto.promoterId),
          csvEscape(dto.eventId),
          csvEscape(dto.status),
          csvEscape(dto.ratePercent),
          csvEscape(dto.flatPaise),
          csvEscape(new Date(dto.createdAt).toISOString()),
        ].join(',');
      });
      const csv = [header.map(csvEscape).join(','), ...lines].join('\n');
      return reply
        .type('text/csv')
        .header('Content-Disposition', 'attachment; filename="promoters.csv"')
        .send(csv);
    },
  );

  fastify.post(
    '/admin/promoters/:promoterId/suspend',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: promoterIdParam,
          headers: commandHeaders,
          body: adminPromoterSuspendRequestSchema,
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { promoterId } = request.params as z.infer<typeof promoterIdParam>;
      const { reason } = request.body as z.infer<typeof adminPromoterSuspendRequestSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.promoter.suspend',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { promoterId }, body: { reason } },
        run: async () => {
          const outcome = await services.adminOps.suspendPromoter(
            userId,
            promoterId,
            reason,
            requestMeta(request),
          );
          const validated = validateV2Response(reply, request, adminPromoterActionResponseSchema, {
            promoterId,
            action: 'suspended',
            affectedAssignments: outcome.affected,
            at: outcome.at.toISOString(),
          });
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, promoterId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, promoterId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.post(
    '/admin/promoters/:promoterId/reinstate',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: promoterIdParam,
          headers: commandHeaders,
          body: adminPromoterSuspendRequestSchema,
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { promoterId } = request.params as z.infer<typeof promoterIdParam>;
      const { reason } = request.body as z.infer<typeof adminPromoterSuspendRequestSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.promoter.reinstate',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { promoterId }, body: { reason } },
        run: async () => {
          const outcome = await services.adminOps.reinstatePromoter(
            userId,
            promoterId,
            reason,
            requestMeta(request),
          );
          const validated = validateV2Response(reply, request, adminPromoterActionResponseSchema, {
            promoterId,
            action: 'reinstated',
            affectedAssignments: outcome.affected,
            at: outcome.at.toISOString(),
          });
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, promoterId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, promoterId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}
