import {
  adminRefundRequestDtoSchema,
  adminRefundRequestListResponseSchema,
  adminRefundRequestStatusSchema,
  idempotencyKeySchema,
  opaqueIdSchema,
  orderDtoSchema,
  paginationQuerySchema,
  rejectRefundRequestSchema,
  requestRefundSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { AdminRefundRequest, Order } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { orderToDto } from '../orders/order-dto.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin refunds (Phase 6 admin) ───────────────────────────────────────────
 *
 * Amount-tiered approval over an order's payment, ported from v1's real
 * money logic — see `packages/core/src/application/finance/refund-service.ts`
 * and `packages/core/src/domain/models/refund-request.ts` for the full
 * design record (why this is its own N-approver accumulator rather than
 * `admin-authority`'s binary propose→resolve, and the exact v1 bug this
 * fixes).
 *
 * Platform authority, same as `onboarding-review.ts`: no `requirePermission`
 * here, every handler reaches `services.refund`, which begins with
 * `AdminAuthorityService.authorize`.
 */

const services = createV2Services();

const refundIdParam = z.object({ refundRequestId: opaqueIdSchema });
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });
const refundQuerySchema = paginationQuerySchema.extend({
  status: adminRefundRequestStatusSchema.optional(),
});

const refundOutcomeSchema = z.object({
  request: adminRefundRequestDtoSchema,
  order: orderDtoSchema,
});
const refundListSchema = adminRefundRequestListResponseSchema;

function toRefundDto(request: AdminRefundRequest) {
  return {
    id: request.id,
    orderId: request.orderId,
    organizationId: request.organizationId,
    amountPaise: request.amountPaise,
    requestedBy: request.requestedBy,
    reason: request.reason,
    approversRequired: request.approversRequired,
    approvals: request.approvals,
    status: request.status,
    rejectedBy: request.rejectedBy,
    rejectionReason: request.rejectionReason,
    providerRefundId: request.providerRefundId,
    failureReason: request.failureReason,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

function toOutcomeDto(outcome: { request: AdminRefundRequest; order: Order }) {
  return {
    request: toRefundDto(outcome.request),
    order: orderToDto(outcome.order),
  };
}

export default async function adminRefundRoutes(fastify: FastifyInstance) {
  /* ─── Request a refund ───────────────────────────────────────────────────── */

  fastify.post(
    '/admin/refunds',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ headers: commandHeaders, body: requestRefundSchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const body = request.body as z.infer<typeof requestRefundSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.refund.request',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: {}, body },
        run: async () => {
          const outcome = await services.refund.requestRefund(userId, {
            orderId: body.orderId,
            amountPaise: body.amountPaise,
            reason: body.reason,
          });
          const validated = validateV2Response(
            reply,
            request,
            refundOutcomeSchema,
            toOutcomeDto(outcome),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, body.orderId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, body.orderId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  /* ─── Approve / reject ───────────────────────────────────────────────────── */

  fastify.post(
    '/admin/refunds/:refundRequestId/approve',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: refundIdParam, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { refundRequestId } = request.params as z.infer<typeof refundIdParam>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.refund.approve',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { refundRequestId }, body: {} },
        run: async () => {
          const outcome = await services.refund.approveRefund(userId, refundRequestId);
          const validated = validateV2Response(
            reply,
            request,
            refundOutcomeSchema,
            toOutcomeDto(outcome),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, refundRequestId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, refundRequestId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.post(
    '/admin/refunds/:refundRequestId/reject',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: refundIdParam,
          headers: commandHeaders,
          body: rejectRefundRequestSchema,
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { refundRequestId } = request.params as z.infer<typeof refundIdParam>;
      const body = request.body as z.infer<typeof rejectRefundRequestSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.refund.reject',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { refundRequestId }, body },
        run: async () => {
          const outcome = await services.refund.rejectRefund(userId, refundRequestId, body.reason);
          const validated = validateV2Response(
            reply,
            request,
            refundOutcomeSchema,
            toOutcomeDto(outcome),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, refundRequestId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, refundRequestId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  /* ─── Reads ──────────────────────────────────────────────────────────────── */

  fastify.get(
    '/admin/refunds',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: refundQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof refundQuerySchema>;

      const page = await services.refund
        .listRefunds(userId, query.status ?? null, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(reply, request, refundListSchema, {
        items: page.items.map(toRefundDto),
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
    '/admin/refunds/:refundRequestId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: refundIdParam })],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { refundRequestId } = request.params as z.infer<typeof refundIdParam>;

      const refund = await services.refund
        .getRefund(userId, refundRequestId)
        .catch((error: unknown) => mapDomainError(reply, request, refundRequestId, error));
      if (refund === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        adminRefundRequestDtoSchema,
        toRefundDto(refund),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}
