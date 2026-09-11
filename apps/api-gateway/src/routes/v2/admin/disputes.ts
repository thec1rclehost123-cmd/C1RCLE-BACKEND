import {
  adminDisputeStatusSchema,
  adminResolveDisputeSchema,
  disputeListResponseSchema,
  disputeResponseSchema,
  idempotencyKeySchema,
  opaqueIdSchema,
  paginationQuerySchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Dispute } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin dispute resolution desk (Phase 6 admin) ───────────────────────────
 *
 * `partner/finance-routes.ts`'s dispute endpoints are org-scoped and never
 * mutate the ledger on resolution — this desk is the follow-up. TIER2,
 * single admin. See `application/finance/admin-dispute-service.ts` for why
 * `upheld` writes a correcting ledger entry and `denied` does not.
 *
 * Platform authority, same as every other admin route in this repo: no
 * `requirePermission` here, `services.adminDispute` begins with
 * `AdminAuthorityService.authorize`/`requireAdmin` internally.
 */

const services = createV2Services();

const disputeIdParam = z.object({ disputeId: opaqueIdSchema });
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });
const disputeQuerySchema = paginationQuerySchema.extend({
  status: adminDisputeStatusSchema,
});

function disputeToDto(dispute: Dispute) {
  return {
    id: dispute.id,
    organizationId: dispute.organizationId,
    orderId: dispute.orderId,
    ledgerEntryId: dispute.ledgerEntryId,
    raisedBy: dispute.raisedBy,
    reason: dispute.reason,
    amountPaise: dispute.amount,
    status: dispute.status,
    resolutionNote: dispute.resolutionNote,
    resolvedAt: dispute.resolvedAt,
    resolution: dispute.resolution,
    createdAt: dispute.createdAt,
  };
}

export default async function adminDisputeRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/admin/disputes/:disputeId/resolve',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: disputeIdParam,
          headers: commandHeaders,
          body: adminResolveDisputeSchema,
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { disputeId } = request.params as z.infer<typeof disputeIdParam>;
      const body = request.body as z.infer<typeof adminResolveDisputeSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.dispute.resolve',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { disputeId }, body },
        run: async () => {
          const dispute = await services.adminDispute.resolve(
            userId,
            disputeId,
            body.outcome,
            body.resolutionNote,
          );
          const validated = validateV2Response(
            reply,
            request,
            disputeResponseSchema,
            disputeToDto(dispute),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, disputeId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, disputeId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.get(
    '/admin/disputes',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: disputeQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof disputeQuerySchema>;

      const page = await services.adminDispute
        .listByStatus(userId, query.status, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(reply, request, disputeListResponseSchema, {
        items: page.items.map(disputeToDto),
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
    '/admin/disputes/:disputeId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: disputeIdParam })],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { disputeId } = request.params as z.infer<typeof disputeIdParam>;

      const dispute = await services.adminDispute
        .getDispute(userId, disputeId)
        .catch((error: unknown) => mapDomainError(reply, request, disputeId, error));
      if (dispute === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        disputeResponseSchema,
        disputeToDto(dispute),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}
