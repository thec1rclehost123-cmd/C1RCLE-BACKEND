import { buildV2ErrorResponse } from '@c1rcle/contracts';
import {
  opaqueIdSchema,
  paginationQuerySchema,
  balanceSummaryResponseSchema,
  ledgerEntryListResponseSchema,
  payoutRequestSchema,
  payoutResponseSchema,
  payoutListResponseSchema,
  bankAccountRequestSchema,
  bankAccountResponseSchema,
  bankAccountListResponseSchema,
} from '@c1rcle/contracts/client';
import { maskAccountNumber } from '@c1rcle/core/domain';
import { z } from 'zod';

import type { BankAccount, LedgerEntry, Payout } from '@c1rcle/core/domain';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── V2 Phase 6 finance slice ────────────────────────────────────────────────
 * Thin routes: validate → build actor → call the Finance/Payout/BankAccount
 * service → serialize. Every route is scoped by `:organizationId` in the path
 * (the same pattern `partner/analytics.ts` uses) — `requireOrgAccess` inside
 * each service is the actual tenancy gate; the RBAC permission here reuses
 * `organization.read`/`organization.update` (no dedicated finance permission
 * exists in the RBAC matrix yet — same precedent as `partner/analytics.ts`'s
 * "VIEW_ANALYTICS maps to organization.read here" comment).
 */

const services = createV2Services();

const organizationIdParam = z.object({ organizationId: opaqueIdSchema });
const payoutIdParam = z.object({ organizationId: opaqueIdSchema, payoutId: opaqueIdSchema });
const bankAccountIdParam = z.object({
  organizationId: opaqueIdSchema,
  bankAccountId: opaqueIdSchema,
});

export default async function financeRoutes(fastify: FastifyInstance) {
  // GET /organizations/:organizationId/finance/balance
  fastify.get(
    '/organizations/:organizationId/finance/balance',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: organizationIdParam }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const actor = services.actor(request);
      const balances = await services.finance
        .getBalances(organizationId, actor)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (balances === undefined) return reply;
      const validated = validateV2Response(reply, request, balanceSummaryResponseSchema, balances);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // GET /organizations/:organizationId/finance/ledger
  fastify.get(
    '/organizations/:organizationId/finance/ledger',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: organizationIdParam, querystring: paginationQuerySchema }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.finance
        .listLedgerEntries(organizationId, actor, {
          cursor: query.cursor ?? null,
          limit: query.limit,
        })
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (page === undefined) return reply;
      const validated = validateV2Response(reply, request, ledgerEntryListResponseSchema, {
        items: page.items.map(ledgerEntryToDto),
        pageInfo: {
          page: 0,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // POST /organizations/:organizationId/payouts
  fastify.post(
    '/organizations/:organizationId/payouts',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: organizationIdParam, body: payoutRequestSchema }),
        fastify.requirePermission('organization.update'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const body = request.body as z.infer<typeof payoutRequestSchema>;
      const actor = services.actor(request);
      const payout = await services.payout
        .requestPayout(
          { organizationId, amount: body.amountPaise, bankAccountId: body.bankAccountId },
          actor,
        )
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (payout === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        payoutResponseSchema,
        payoutToDto(payout),
      );
      if (validated === undefined) return reply;
      return reply.status(201).send(validated);
    },
  );

  // GET /organizations/:organizationId/payouts
  fastify.get(
    '/organizations/:organizationId/payouts',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: organizationIdParam, querystring: paginationQuerySchema }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.payout
        .listPayouts(organizationId, actor, { cursor: query.cursor ?? null, limit: query.limit })
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (page === undefined) return reply;
      const validated = validateV2Response(reply, request, payoutListResponseSchema, {
        items: page.items.map(payoutToDto),
        pageInfo: {
          page: 0,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // GET /organizations/:organizationId/payouts/:payoutId
  fastify.get(
    '/organizations/:organizationId/payouts/:payoutId',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: payoutIdParam }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { organizationId, payoutId } = request.params as z.infer<typeof payoutIdParam>;
      const actor = services.actor(request);
      const payout = await services.payout
        .getPayout(payoutId, actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, organizationId, error, { hideForbidden: true }),
        );
      if (payout === undefined) return reply;
      if (payout === null || payout.organizationId !== organizationId) {
        mapDomainError(reply, request, payoutId, new Error('not_found'), { hideForbidden: true });
        return reply;
      }
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

  // POST /organizations/:organizationId/bank-accounts
  fastify.post(
    '/organizations/:organizationId/bank-accounts',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: organizationIdParam, body: bankAccountRequestSchema }),
        fastify.requirePermission('organization.update'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const body = request.body as z.infer<typeof bankAccountRequestSchema>;
      const actor = services.actor(request);
      const account = await services.bankAccount
        .addBankAccount(
          {
            organizationId,
            bankName: body.bankName,
            accountHolder: body.accountHolder,
            accountNumber: body.accountNumber,
            ifscCode: body.ifscCode,
          },
          actor,
        )
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (account === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        bankAccountResponseSchema,
        bankAccountToDto(account),
      );
      if (validated === undefined) return reply;
      return reply.status(201).send(validated);
    },
  );

  // GET /organizations/:organizationId/bank-accounts
  fastify.get(
    '/organizations/:organizationId/bank-accounts',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: organizationIdParam }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const actor = services.actor(request);
      const accounts = await services.bankAccount
        .listBankAccounts(organizationId, actor)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (accounts === undefined) return reply;
      const validated = validateV2Response(reply, request, bankAccountListResponseSchema, {
        items: accounts.map(bankAccountToDto),
      });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // POST /organizations/:organizationId/bank-accounts/:bankAccountId/default
  fastify.post(
    '/organizations/:organizationId/bank-accounts/:bankAccountId/default',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: bankAccountIdParam }),
        fastify.requirePermission('organization.update'),
      ],
    },
    async (request, reply) => {
      const { organizationId, bankAccountId } = request.params as z.infer<
        typeof bankAccountIdParam
      >;
      const actor = services.actor(request);
      const account = await services.bankAccount
        .setDefaultBankAccount(bankAccountId, actor)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (account === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        bankAccountResponseSchema,
        bankAccountToDto(account),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // DELETE /organizations/:organizationId/bank-accounts/:bankAccountId
  fastify.delete(
    '/organizations/:organizationId/bank-accounts/:bankAccountId',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: bankAccountIdParam }),
        fastify.requirePermission('organization.update'),
      ],
    },
    async (request, reply) => {
      const { organizationId, bankAccountId } = request.params as z.infer<
        typeof bankAccountIdParam
      >;
      const actor = services.actor(request);
      const ok = await services.bankAccount
        .removeAccount(bankAccountId, actor)
        .then(() => true as const)
        .catch((error: unknown) => {
          mapDomainError(reply, request, organizationId, error);
          return undefined;
        });
      if (ok === undefined) return reply;
      return reply.status(204).send();
    },
  );
}

function ledgerEntryToDto(entry: LedgerEntry) {
  return {
    id: entry.id,
    orderId: entry.orderId,
    eventId: entry.eventId,
    entryType: entry.entryType,
    amountPaise: entry.amount,
    status: entry.status,
    createdAt: entry.createdAt,
  };
}

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

function bankAccountToDto(account: BankAccount) {
  return {
    id: account.id,
    bankName: account.bankName,
    accountHolder: account.accountHolder,
    maskedAccountNumber: maskAccountNumber(account.last4),
    ifscCode: account.ifscCode,
    isDefault: account.isDefault,
    verified: account.verified,
    createdAt: account.createdAt,
  };
}

/**
 * Local copy, same convention as `door/cover-wallet-routes.ts`'s
 * `mapDomainError` (no shared version exists — each Phase-5/6 slice keeps its
 * own per that file's doc comment on why importing another route file's
 * mapper risks silent fallthrough for a code that mapper doesn't expect).
 */
function mapDomainError(
  reply: FastifyReply,
  request: FastifyRequest,
  resourceId: string,
  error: unknown,
  options: { hideForbidden?: boolean } = {},
): undefined {
  const known = error as { code?: string; message?: string };
  if (known?.code === 'not_found' || (error instanceof Error && error.message === 'not_found')) {
    reply.status(404).send(
      buildV2ErrorResponse({
        status: 404,
        message: 'Not found',
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
  if (known?.code === 'version_conflict') {
    reply.status(409).send(
      buildV2ErrorResponse({
        status: 409,
        message: known.message ?? 'Version conflict',
        code: 'conflict',
        requestId: request.id,
      }),
    );
    return undefined;
  }
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
