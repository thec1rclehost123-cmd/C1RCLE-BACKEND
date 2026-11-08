import {
  createTaxRuleSchema,
  enableTaxRuleSchema,
  idempotencyKeySchema,
  opaqueIdSchema,
  reconciliationResultSchema,
  retireTaxRuleSchema,
  taxRuleDtoSchema,
  taxRuleKindSchema,
  taxRuleListResponseSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { TaxRule } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { requestMeta } from '../../../lib/v2-request-meta.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin finance controls: tax rules and payment reconciliation ────────────
 *
 * Tax rates are approval-gated data (see `domain/models/tax-rule.ts`): a rule
 * starts as a draft with no effect, is enabled by a DIFFERENT admin against a
 * reference to written advice, and is never edited, only retired. Nothing in
 * pricing or settlement reads them yet.
 *
 * Reconciliation compares one order with what the payment provider reported
 * (see `domain/models/provider-payment.ts`). Read-only.
 *
 * Platform authority, as for every admin route: no `requirePermission`; the
 * services begin with `AdminAuthorityService` checks (tax additionally limits
 * itself to super / admin / finance).
 */

const services = createV2Services();

const ruleIdParam = z.object({ ruleId: opaqueIdSchema });
const orderIdParam = z.object({ orderId: opaqueIdSchema });
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });
const listQuerySchema = z.object({ kind: taxRuleKindSchema.optional() });

function taxRuleToDto(rule: TaxRule) {
  return {
    id: rule.id,
    kind: rule.kind,
    rateBps: rule.rateBps,
    basis: rule.basis,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    status: rule.status,
    approvalRef: rule.approvalRef,
    notes: rule.notes,
    createdBy: rule.createdBy,
    enabledBy: rule.enabledBy,
    enabledAt: rule.enabledAt,
    retiredBy: rule.retiredBy,
    retiredAt: rule.retiredAt,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

export default async function adminFinanceControlRoutes(fastify: FastifyInstance) {
  /* ─── Tax rules: reads ───────────────────────────────────────────────────── */

  fastify.get(
    '/admin/tax-rules',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: listQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof listQuerySchema>;

      const rules = await services.taxRules
        .list(userId, query.kind)
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (rules === undefined) return reply;

      const validated = validateV2Response(reply, request, taxRuleListResponseSchema, {
        items: rules.map(taxRuleToDto),
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  /* ─── Tax rules: draft / enable / retire ─────────────────────────────────── */

  fastify.post(
    '/admin/tax-rules',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ headers: commandHeaders, body: createTaxRuleSchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const body = request.body as z.infer<typeof createTaxRuleSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.taxRule.create',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: {}, body },
        run: async () => {
          const rule = await services.taxRules.createDraft(userId, body, requestMeta(request));
          const validated = validateV2Response(
            reply,
            request,
            taxRuleDtoSchema,
            taxRuleToDto(rule),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
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

  fastify.post(
    '/admin/tax-rules/:ruleId/enable',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: ruleIdParam,
          headers: commandHeaders,
          body: enableTaxRuleSchema,
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { ruleId } = request.params as z.infer<typeof ruleIdParam>;
      const body = request.body as z.infer<typeof enableTaxRuleSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.taxRule.enable',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { ruleId }, body },
        run: async () => {
          const rule = await services.taxRules.enable(
            userId,
            ruleId,
            body.approvalRef,
            requestMeta(request),
          );
          const validated = validateV2Response(
            reply,
            request,
            taxRuleDtoSchema,
            taxRuleToDto(rule),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, ruleId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, ruleId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.post(
    '/admin/tax-rules/:ruleId/retire',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: ruleIdParam,
          headers: commandHeaders,
          body: retireTaxRuleSchema,
        }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { ruleId } = request.params as z.infer<typeof ruleIdParam>;
      const body = request.body as z.infer<typeof retireTaxRuleSchema>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.taxRule.retire',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { ruleId }, body },
        run: async () => {
          const rule = await services.taxRules.retire(
            userId,
            ruleId,
            body.reason,
            requestMeta(request),
          );
          const validated = validateV2Response(
            reply,
            request,
            taxRuleDtoSchema,
            taxRuleToDto(rule),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, ruleId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, ruleId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  /* ─── Reconciliation ─────────────────────────────────────────────────────── */

  fastify.get(
    '/admin/finance/reconciliation/:orderId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: orderIdParam })],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { orderId } = request.params as z.infer<typeof orderIdParam>;

      const result = await services.providerPayments
        .reconcileOrderForAdmin(userId, orderId)
        .catch((error: unknown) => mapDomainError(reply, request, orderId, error));
      if (result === undefined) return reply;

      const validated = validateV2Response(reply, request, reconciliationResultSchema, result);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}
