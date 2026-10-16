import {
  idempotencyKeySchema,
  opaqueIdSchema,
  paginationQuerySchema,
  reconciliationDiscrepancyDtoSchema,
  reconciliationDiscrepancyListResponseSchema,
  reconciliationDiscrepancyStateSchema,
  reconciliationRunDtoSchema,
  reconciliationRunListResponseSchema,
  resolveReconciliationDiscrepancySchema,
} from '@c1rcle/contracts/client';
import { NotFoundError } from '@c1rcle/core/domain';
import { z } from 'zod';

import type { ReconciliationDiscrepancy } from '@c1rcle/core/domain';

import { csvEscape } from '../../../lib/csv.js';
import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { requestMeta } from '../../../lib/v2-request-meta.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

const services = createV2Services();
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });
const runParam = z.object({ runId: opaqueIdSchema });
const discrepancyParam = z.object({ discrepancyId: opaqueIdSchema });
const discrepancyQuery = paginationQuerySchema.extend({
  runId: opaqueIdSchema.optional(),
  state: reconciliationDiscrepancyStateSchema.optional(),
});

function discrepancyDto(item: ReconciliationDiscrepancy) {
  return {
    id: item.id,
    runId: item.runId,
    kind: item.kind,
    state: item.state,
    organizationId: item.organizationId,
    orderId: item.orderId,
    paymentId: item.paymentId,
    payoutId: item.payoutId,
    amountPaise: item.amountPaise,
    currency: item.currency,
    evidence: item.evidence,
    repair: item.repair,
    resolutionReason: item.resolutionReason,
    resolvedBy: item.resolvedBy,
    resolvedAt: item.resolvedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function pageInfo(page: { total: number; nextCursor: string | null }, pageSize: number) {
  return { page: 1, pageSize, total: page.total, hasNextPage: page.nextCursor !== null };
}

export default async function adminReconciliationRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/admin/reconciliation/runs',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.reconciliation.run',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: {}, body: {} },
        run: async () => {
          const admin = await services.adminAuthority.authorize(userId, 'RECONCILIATION_RUN');
          const run = await services.reconciliation.run(userId);
          await services.adminAuthority.record(admin, {
            action: 'RECONCILIATION_RUN',
            targetType: 'reconciliation_run',
            targetId: run.id,
            before: null,
            after: { status: run.status, discrepancyCount: run.discrepancyCount },
            reason: 'Manual finance reconciliation run',
            ...requestMeta(request),
          });
          const body = validateV2Response(reply, request, reconciliationRunDtoSchema, run);
          if (!body) throw new Error('v2 response validation failed');
          return { statusCode: 201, body };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, userId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, userId, error),
      );
      if (!result) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.get(
    '/admin/reconciliation/runs',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: paginationQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      await services.adminAuthority.requireAdmin(userId);
      const page = await services.reconciliation.listRuns(query);
      return validateV2Response(reply, request, reconciliationRunListResponseSchema, {
        items: page.items,
        pageInfo: pageInfo(page, query.limit),
      });
    },
  );

  fastify.get(
    '/admin/reconciliation/runs/:runId',
    { preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: runParam })] },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { runId } = request.params as z.infer<typeof runParam>;
      await services.adminAuthority.requireAdmin(userId);
      const run = await services.reconciliation.getRun(runId);
      if (!run) return mapDomainError(reply, request, runId, new NotFoundError('run', runId));
      return validateV2Response(reply, request, reconciliationRunDtoSchema, run);
    },
  );

  fastify.get(
    '/admin/reconciliation/discrepancies',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: discrepancyQuery }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof discrepancyQuery>;
      await services.adminAuthority.requireAdmin(userId);
      const page = await services.reconciliation.listDiscrepancies(query);
      return validateV2Response(reply, request, reconciliationDiscrepancyListResponseSchema, {
        items: page.items.map(discrepancyDto),
        pageInfo: pageInfo(page, query.limit),
      });
    },
  );

  fastify.get(
    '/admin/reconciliation/discrepancies/:discrepancyId',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: discrepancyParam }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { discrepancyId } = request.params as z.infer<typeof discrepancyParam>;
      await services.adminAuthority.requireAdmin(userId);
      const item = await services.reconciliation.getDiscrepancy(discrepancyId);
      if (!item) {
        return mapDomainError(
          reply,
          request,
          discrepancyId,
          new NotFoundError('discrepancy', discrepancyId),
        );
      }
      return validateV2Response(
        reply,
        request,
        reconciliationDiscrepancyDtoSchema,
        discrepancyDto(item),
      );
    },
  );

  fastify.post(
    '/admin/reconciliation/discrepancies/:discrepancyId/retry',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: discrepancyParam, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { discrepancyId } = request.params as z.infer<typeof discrepancyParam>;
      const item = await services.reconciliation.getDiscrepancy(discrepancyId);
      if (!item) {
        return mapDomainError(
          reply,
          request,
          discrepancyId,
          new NotFoundError('discrepancy', discrepancyId),
        );
      }
      if (item.repair !== 'recheck_evidence') {
        return reply
          .code(409)
          .send({ error: { code: 'conflict', message: 'Repair is not allow-listed' } });
      }
      const admin = await services.adminAuthority.authorize(userId, 'RECONCILIATION_RUN');
      const run = await services.reconciliation.run(userId);
      await services.adminAuthority.record(admin, {
        action: 'RECONCILIATION_RUN',
        targetType: 'reconciliation_discrepancy',
        targetId: discrepancyId,
        before: { state: item.state },
        after: { recheckRunId: run.id },
        reason: 'Allow-listed evidence recheck',
        ...requestMeta(request),
      });
      return validateV2Response(reply, request, reconciliationRunDtoSchema, run);
    },
  );

  fastify.post(
    '/admin/reconciliation/discrepancies/:discrepancyId/resolve',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: discrepancyParam,
          body: resolveReconciliationDiscrepancySchema,
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { discrepancyId } = request.params as z.infer<typeof discrepancyParam>;
      const body = request.body as z.infer<typeof resolveReconciliationDiscrepancySchema>;
      const admin = await services.adminAuthority.authorize(userId, 'RECONCILIATION_RESOLVE');
      const before = await services.reconciliation.getDiscrepancy(discrepancyId);
      const item = await services.reconciliation.resolve(discrepancyId, body.reason, userId);
      await services.adminAuthority.record(admin, {
        action: 'RECONCILIATION_RESOLVE',
        targetType: 'reconciliation_discrepancy',
        targetId: discrepancyId,
        before: { state: before?.state ?? null },
        after: { state: item.state },
        reason: body.reason,
        ...requestMeta(request),
      });
      return validateV2Response(
        reply,
        request,
        reconciliationDiscrepancyDtoSchema,
        discrepancyDto(item),
      );
    },
  );

  fastify.get('/admin/reconciliation/export.csv', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (userId === undefined) return reply;
    await services.adminAuthority.requireAdmin(userId);
    const rows = await services.reconciliation.listDiscrepancies({ limit: 10_000 });
    const header = [
      'id',
      'runId',
      'kind',
      'state',
      'organizationId',
      'orderId',
      'paymentId',
      'payoutId',
      'amountPaise',
      'currency',
    ];
    const csv = [
      header.join(','),
      ...rows.items.map((item) =>
        [
          item.id,
          item.runId,
          item.kind,
          item.state,
          item.organizationId,
          item.orderId,
          item.paymentId,
          item.payoutId,
          item.amountPaise,
          item.currency,
        ]
          .map(csvEscape)
          .join(','),
      ),
    ].join('\n');
    return reply.type('text/csv; charset=utf-8').send(csv);
  });
}
