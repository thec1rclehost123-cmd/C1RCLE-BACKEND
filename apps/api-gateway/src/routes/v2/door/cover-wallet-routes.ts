import { buildV2ErrorResponse } from '@c1rcle/contracts';
import {
  opaqueIdSchema,
  idempotencyKeySchema,
  coverWalletIssueRequestSchema,
  coverWalletDebitRequestSchema,
  coverWalletCreditRequestSchema,
  coverWalletResponseSchema,
  coverWalletReconciliationRequestSchema,
  coverWalletReconciliationResponseSchema,
} from '@c1rcle/contracts/client';
import { InvalidOperationError, NotFoundError } from '@c1rcle/core/domain';
import { z } from 'zod';

import type { CoverWallet, CoverWalletReconciliation } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── V2 Phase 5 cover-wallet slice ────────────────────────────────────────────
 * Thin routes (T16): validate → build actor → call `CoverWalletService` →
 * serialize to the canonical `coverWalletResponseSchema`/
 * `coverWalletReconciliationResponseSchema`. No Firestore, no business logic
 * here — that all lives in `packages/core/src/application/cover-wallet/`.
 *
 * Split out of `phase5-routes.ts` into its own file (door/cover-wallet-routes.ts)
 * so this slice's HTTP wiring can land without touching the same file the
 * scanner/door-sale slices are being wired in concurrently. Registration into
 * the `/api/v2` route manifest happens elsewhere — this file only exports the
 * plugin function.
 */

const services = createV2Services();

const walletIdParam = z.object({ walletId: opaqueIdSchema });

/**
 * `coverWalletDebitRequestSchema` (packages/contracts/src/contracts/phase5.ts)
 * has no `isOnline` field — the field genuinely doesn't exist in the shared
 * contract. But the v1 rule (docs/PHASE_5_HTTP_WIRING_PLAN.md point 3) is
 * "offline debits blocked at the API layer": `CoverWalletService.debitWallet`
 * (packages/core/src/application/cover-wallet/cover-wallet-service.ts:340-380)
 * has no offline/online concept at all — only a velocity check and an
 * active-wallet check. So the flag is required here, at the route boundary,
 * extending (not replacing) the contract schema.
 */
const coverWalletDebitBody = coverWalletDebitRequestSchema.extend({
  isOnline: z.boolean(),
});

/**
 * No `coverWalletTerminateRequestSchema` exists in contracts/phase5.ts (only
 * issue/debit/credit/reconcile do) — this one stays a local inline schema.
 * `terminatedBy` isn't part of the body: the actor (from the session) is the
 * terminator, matching `terminateWallet(walletId, reason, actor)`'s signature.
 */
const coverWalletTerminateBody = z.object({ reason: z.string().min(1) }).strict();

/** Optional replay-safety header for mutations whose domain input has no idempotency key of its own. */
const idempotencyHeaders = z.looseObject({
  'idempotency-key': idempotencyKeySchema.optional(),
});

export default async function phase5CoverWalletRoutes(fastify: FastifyInstance) {
  // =============================================================================
  // COVER WALLET ROUTES
  // =============================================================================

  /**
   * POST /api/v2/cover-wallets
   * Issue wallet (on cover-charge ticket purchase).
   */
  fastify.post(
    '/cover-wallets',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: coverWalletIssueRequestSchema, headers: idempotencyHeaders }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof coverWalletIssueRequestSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'cover_wallet.create',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: {}, body },
        run: async () => {
          const wallet = await services.coverWallet.createWallet(
            {
              eventId: body.eventId,
              userId: body.userId,
              openingBalance: body.openingBalancePaise,
              metadata: body.metadata,
            },
            actor,
          );
          const validated = validateV2Response(
            reply,
            request,
            coverWalletResponseSchema,
            coverWalletToDto(wallet),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, 'new_cover_wallet', error, {
            conflictId: v2Headers['idempotency-key'],
          });
        }
        return mapDomainError(reply, request, 'new_cover_wallet', error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  /**
   * GET /api/v2/cover-wallets/:walletId
   * Get wallet state. `getWallet` returns `null` (not a thrown NotFoundError)
   * on a miss — routed through the same 404 mapping as everywhere else so
   * callers see one consistent not-found shape regardless of which service
   * method produced it.
   */
  fastify.get(
    '/cover-wallets/:walletId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: walletIdParam })],
    },
    async (request, reply) => {
      const { walletId } = request.params as z.infer<typeof walletIdParam>;
      const actor = services.actor(request);
      const wallet = await services.coverWallet
        .getWallet(walletId, actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, walletId, error, { hideForbidden: true }),
        );
      if (wallet === undefined) return reply;
      if (wallet === null) {
        mapDomainError(reply, request, walletId, new NotFoundError('Wallet', walletId), {
          hideForbidden: true,
        });
        return reply;
      }
      const validated = validateV2Response(
        reply,
        request,
        coverWalletResponseSchema,
        coverWalletToDto(wallet),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  /**
   * POST /api/v2/cover-wallets/:walletId/debit
   * Debit wallet (velocity limit + terminated-wallet checks live in
   * `CoverWalletService.debitWallet`; the offline-debit ban is enforced here).
   */
  fastify.post(
    '/cover-wallets/:walletId/debit',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: walletIdParam, body: coverWalletDebitBody }),
      ],
    },
    async (request, reply) => {
      const { walletId } = request.params as z.infer<typeof walletIdParam>;
      const body = request.body as z.infer<typeof coverWalletDebitBody>;
      const actor = services.actor(request);
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'cover_wallet.debit',
        idempotencyKey: body.idempotencyKey,
        context: { path: { walletId }, body },
        run: async () => {
          // v1 rule (docs/PHASE_5_HTTP_WIRING_PLAN.md point 3): offline debits
          // are blocked at the API layer. CoverWalletService.debitWallet has
          // no offline/online concept — this check has to live here.
          if (!body.isOnline) {
            throw new InvalidOperationError(
              'Offline debits are not permitted (blocked at the API layer, v1 rule)',
            );
          }
          const { wallet } = await services.coverWallet.debitWallet(
            {
              walletId,
              amount: body.amountPaise,
              referenceId: body.referenceId,
              referenceType: body.referenceType,
              description: body.description,
              idempotencyKey: body.idempotencyKey,
              deviceId: body.deviceId,
            },
            actor,
          );
          const validated = validateV2Response(
            reply,
            request,
            coverWalletResponseSchema,
            coverWalletToDto(wallet),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, walletId, error, {
            conflictId: body.idempotencyKey,
          });
        }
        return mapDomainError(reply, request, walletId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  /**
   * POST /api/v2/cover-wallets/:walletId/credit
   * Credit wallet (refund / top-up). Only ONE registration — the original
   * stub file registered this route twice; the duplicate is dropped here.
   */
  fastify.post(
    '/cover-wallets/:walletId/credit',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: walletIdParam, body: coverWalletCreditRequestSchema }),
      ],
    },
    async (request, reply) => {
      const { walletId } = request.params as z.infer<typeof walletIdParam>;
      const body = request.body as z.infer<typeof coverWalletCreditRequestSchema>;
      const actor = services.actor(request);
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'cover_wallet.credit',
        idempotencyKey: body.idempotencyKey,
        context: { path: { walletId }, body },
        run: async () => {
          const { wallet } = await services.coverWallet.creditWallet(
            {
              walletId,
              amount: body.amountPaise,
              referenceId: body.referenceId,
              referenceType: body.referenceType,
              description: body.description,
              idempotencyKey: body.idempotencyKey,
            },
            actor,
          );
          const validated = validateV2Response(
            reply,
            request,
            coverWalletResponseSchema,
            coverWalletToDto(wallet),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, walletId, error, {
            conflictId: body.idempotencyKey,
          });
        }
        return mapDomainError(reply, request, walletId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  /**
   * POST /api/v2/cover-wallets/:walletId/freeze
   * NOT IMPLEMENTED. `CoverWalletService` (packages/core/src/application/
   * cover-wallet/cover-wallet-service.ts) exposes `terminateWallet` and
   * `closeWallet` — both irreversible — but no `freeze`/`unfreeze` method.
   * Faking freeze via `terminateWallet` would be wrong (termination is
   * permanent and balance-depleting; a freeze must be reversible). This
   * needs a new service method (and probably a `frozen` `CoverWalletStatus`)
   * before it can be honestly wired — not a route-layer gap.
   */
  fastify.post(
    '/cover-wallets/:walletId/freeze',
    {
      preHandler: [fastify.rateLimit('STANDARD_COMMAND'), fastify.validateV2({ params: walletIdParam })],
    },
    async (request, reply) => {
      return reply.status(501).send(
        buildV2ErrorResponse({
          status: 501,
          code: 'server',
          message:
            'Not implemented: CoverWalletService has no freeze method — needs a new service method before this route can be wired',
          requestId: request.id,
        }),
      );
    },
  );

  /**
   * POST /api/v2/cover-wallets/:walletId/unfreeze
   * NOT IMPLEMENTED — same gap as freeze above (no matching service method).
   */
  fastify.post(
    '/cover-wallets/:walletId/unfreeze',
    {
      preHandler: [fastify.rateLimit('STANDARD_COMMAND'), fastify.validateV2({ params: walletIdParam })],
    },
    async (request, reply) => {
      return reply.status(501).send(
        buildV2ErrorResponse({
          status: 501,
          code: 'server',
          message:
            'Not implemented: CoverWalletService has no unfreeze method — needs a new service method before this route can be wired',
          requestId: request.id,
        }),
      );
    },
  );

  /**
   * POST /api/v2/cover-wallets/:walletId/terminate
   * Terminate wallet (irreversible).
   */
  fastify.post(
    '/cover-wallets/:walletId/terminate',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: walletIdParam,
          body: coverWalletTerminateBody,
          headers: idempotencyHeaders,
        }),
      ],
    },
    async (request, reply) => {
      const { walletId } = request.params as z.infer<typeof walletIdParam>;
      const body = request.body as z.infer<typeof coverWalletTerminateBody>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'cover_wallet.terminate',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { walletId }, body },
        run: async () => {
          const wallet = await services.coverWallet.terminateWallet(walletId, body.reason, actor);
          const validated = validateV2Response(
            reply,
            request,
            coverWalletResponseSchema,
            coverWalletToDto(wallet),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, walletId, error, {
            conflictId: v2Headers['idempotency-key'],
          });
        }
        return mapDomainError(reply, request, walletId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  /**
   * POST /api/v2/cover-wallets/:walletId/reconcile
   * Reconcile wallet. `:walletId` in the path is authoritative — if the body
   * (validated against `coverWalletReconciliationRequestSchema`, which also
   * carries an optional `walletId`) disagrees, the path wins, so there is no
   * ambiguity about which wallet is being reconciled.
   */
  fastify.post(
    '/cover-wallets/:walletId/reconcile',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: walletIdParam,
          body: coverWalletReconciliationRequestSchema,
          headers: idempotencyHeaders,
        }),
      ],
    },
    async (request, reply) => {
      const { walletId } = request.params as z.infer<typeof walletIdParam>;
      const body = request.body as z.infer<typeof coverWalletReconciliationRequestSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'cover_wallet.reconcile',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { walletId }, body },
        run: async () => {
          const reconciliation = await services.coverWallet.runReconciliation(
            {
              eventId: body.eventId,
              reconciliationDate: body.reconciliationDate,
              walletId,
              userId: body.userId,
            },
            actor,
          );
          const validated = validateV2Response(
            reply,
            request,
            coverWalletReconciliationResponseSchema,
            reconciliationToDto(reconciliation),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, walletId, error, {
            conflictId: v2Headers['idempotency-key'],
          });
        }
        return mapDomainError(reply, request, walletId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}

/** Converts the core domain CoverWallet to the canonical wire DTO. */
export function coverWalletToDto(wallet: CoverWallet) {
  return {
    id: wallet.id,
    eventId: wallet.eventId,
    userId: wallet.userId,
    balancePaise: wallet.balance,
    status: wallet.status,
    openingBalancePaise: wallet.openingBalance,
    totalCreditsPaise: wallet.totalCredits,
    totalDebitsPaise: wallet.totalDebits,
    terminatedAt: wallet.terminatedAt,
    createdAt: wallet.createdAt,
  };
}

/** Converts the core domain CoverWalletReconciliation to the canonical wire DTO. */
export function reconciliationToDto(reconciliation: CoverWalletReconciliation) {
  return {
    id: reconciliation.id,
    eventId: reconciliation.eventId,
    reconciliationDate: reconciliation.reconciliationDate,
    expectedBalancePaise: reconciliation.expectedBalance,
    actualBalancePaise: reconciliation.actualBalance,
    discrepancyPaise: reconciliation.discrepancy,
    status: reconciliation.status,
    discrepancies: reconciliation.discrepancies.map((discrepancy) => ({
      type: discrepancy.type,
      walletId: discrepancy.walletId,
      expectedAmountPaise: discrepancy.expectedAmount,
      actualAmountPaise: discrepancy.actualAmount,
      transactionId: discrepancy.transactionId,
      description: discrepancy.description,
    })),
    createdAt: reconciliation.createdAt,
  };
}

/**
 * Maps core domain errors to the V2 error envelope; returns `undefined` after
 * sending. Local copy (not a shared import) because the generic `NotFoundError`
 * (`code: 'not_found'`, thrown throughout `cover-wallet-service.ts` — see
 * `createWallet`/`getWalletByEventAndUser`/`creditWallet`/`debitWallet`/
 * `terminateWallet`/`runReconciliation`, all via `throw new NotFoundError(...)`)
 * is NOT one of the specific `*NotFoundError` subclasses the shared
 * `plugins/error-handler.ts` maps, nor one of the resource-specific string
 * codes in `partner/events.ts`'s local `notFoundCodes` set — importing that
 * file's `mapDomainError` (as `partner/organizations.ts` does) would silently
 * fall through Phase 5's `not_found` errors into an unlogged 500. `'not_found'`
 * is handled here as its own first-class branch instead of a per-resource
 * string, per docs/PHASE_5_HTTP_WIRING_PLAN.md point 4.
 *
 * Separately: there is no wallet-terminated-specific error class/code in
 * `packages/core/src/domain/errors.ts` — `debitWallet`/`creditWallet`/
 * `refundWallet`/`adjustWallet` all reject an inactive/terminated wallet via
 * the generic `InvalidOperationError` (`code: 'invalid_operation'`), which
 * this file maps to 400, same as `partner/events.ts` does for the same code.
 */
export function mapDomainError(
  reply: FastifyReply,
  request: FastifyRequest,
  resourceId: string,
  error: unknown,
  options: { hideForbidden?: boolean; conflictId?: string } = {},
): undefined {
  const known = error as {
    code?: string;
    message?: string;
    expectedVersion?: number;
    currentVersion?: number;
  };
  if (known?.code === 'not_found') {
    reply.status(404).send(
      buildV2ErrorResponse({
        status: 404,
        message: known.message ?? 'Not found',
        code: 'not_found',
        requestId: request.id,
      }),
    );
    return undefined;
  }
  // No session at all (or no platform-admin authority) — distinct from
  // `forbidden`, which means a valid identity in the wrong scope.
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
    // Single-resource reads hide cross-tenant existence (IDOR guard): a
    // forbidden fetch is reported as 404, never as it being someone else's.
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
  if (known?.code === 'version_conflict') {
    reply.status(409).send(
      buildV2ErrorResponse({
        status: 409,
        message: known.message ?? 'Version conflict',
        code: 'conflict',
        requestId: request.id,
        details: {
          expectedVersion: known.expectedVersion,
          currentVersion: known.currentVersion,
        },
      }),
    );
    return undefined;
  }
  if (known?.code === 'idempotency_conflict' || known?.code === 'idempotency_in_flight') {
    reply.status(409).send(
      buildV2ErrorResponse({
        status: 409,
        message: known.message ?? 'Idempotency conflict',
        code: 'conflict',
        requestId: request.id,
        details: { idempotencyKey: options.conflictId },
      }),
    );
    return undefined;
  }
  if (known?.code === 'state_transition') {
    reply.status(409).send(
      buildV2ErrorResponse({
        status: 409,
        message: known.message ?? 'Illegal state transition',
        code: 'conflict',
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
  // Anything else is a genuine bug — log it rather than silently swallowing
  // an unmapped domain error code into an unlogged 500.
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
