import {
  adminPayoutStatusSchema,
  idempotencyKeySchema,
  opaqueIdSchema,
  paginationQuerySchema,
  payoutBatchResultSchema,
  payoutListResponseSchema,
  payoutResponseSchema,
  runPayoutBatchSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Payout } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin payout controls (Phase 6 admin) ───────────────────────────────────
 *
 * Freeze/release execute from an approved dual-control proposal — raise one
 * via the existing `POST /admin/proposals` desk (`action: 'PAYOUT_FREEZE'`
 * or `'PAYOUT_RELEASE'`, `payload: { payoutId }`), get it approved by a
 * second admin, then execute here. Same shape as
 * `onboarding-review.ts`'s `/admin/proposals/:proposalId/provision-admin`.
 * See `application/finance/admin-payout-service.ts` for why release is
 * dual-control too, unlike v1.
 *
 * Platform authority: no `requirePermission` here, same as every other
 * admin route in this repo — `services.adminPayout` begins with
 * `AdminAuthorityService.authorize`/`requireAdmin` internally.
 */

const services = createV2Services();

const proposalIdParam = z.object({ proposalId: opaqueIdSchema });
const payoutIdParam = z.object({ payoutId: opaqueIdSchema });
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });
const payoutQuerySchema = paginationQuerySchema.extend({
  status: adminPayoutStatusSchema.optional(),
});

function payoutToDto(payout: Payout) {
  return {
    id: payout.id,
    organizationId: payout.organizationId,
    bankAccountId: payout.bankAccountId,
    amountPaise: payout.amount,
    status: payout.status,
    failureReason: payout.failureReason,
    processedAt: payout.processedAt,
    createdAt: payout.createdAt,
  };
}

export default async function adminPayoutRoutes(fastify: FastifyInstance) {
  /* ─── Freeze / release (execute an approved proposal) ───────────────────── */

  fastify.post(
    '/admin/proposals/:proposalId/freeze-payout',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: proposalIdParam, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { proposalId } = request.params as z.infer<typeof proposalIdParam>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.payout.freeze',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { proposalId }, body: {} },
        run: async () => {
          const payout = await services.adminPayout.freezePayoutFromProposal(userId, proposalId);
          const validated = validateV2Response(
            reply,
            request,
            payoutResponseSchema,
            payoutToDto(payout),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, proposalId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, proposalId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.post(
    '/admin/proposals/:proposalId/release-payout',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: proposalIdParam, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { proposalId } = request.params as z.infer<typeof proposalIdParam>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.payout.release',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { proposalId }, body: {} },
        run: async () => {
          const payout = await services.adminPayout.releasePayoutFromProposal(userId, proposalId);
          const validated = validateV2Response(
            reply,
            request,
            payoutResponseSchema,
            payoutToDto(payout),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, proposalId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, proposalId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  /* ─── Batch run (TIER2, single admin) ────────────────────────────────────── */

  fastify.post(
    '/admin/payouts/batch-run',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ headers: commandHeaders, body: runPayoutBatchSchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const body = request.body as z.infer<typeof runPayoutBatchSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.payout.batch_run',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: {}, body },
        run: async () => {
          const outcome = await services.adminPayout.runBatch(userId, body.payoutIds);
          const validated = validateV2Response(reply, request, payoutBatchResultSchema, {
            processed: outcome.processed.map(payoutToDto),
            skipped: outcome.skipped,
          });
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, userId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, userId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  /* ─── Reads ──────────────────────────────────────────────────────────────── */

  fastify.get(
    '/admin/payouts',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: payoutQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof payoutQuerySchema>;

      const page = await services.adminPayout
        .listByStatus(userId, query.status ?? null, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(reply, request, payoutListResponseSchema, {
        items: page.items.map(payoutToDto),
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
    '/admin/payouts/:payoutId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: payoutIdParam })],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { payoutId } = request.params as z.infer<typeof payoutIdParam>;

      const payout = await services.adminPayout
        .getPayout(userId, payoutId)
        .catch((error: unknown) => mapDomainError(reply, request, payoutId, error));
      if (payout === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        payoutResponseSchema,
        payoutToDto(payout),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}
