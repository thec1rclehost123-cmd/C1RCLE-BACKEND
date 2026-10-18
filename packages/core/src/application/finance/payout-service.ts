import { ForbiddenError, IdempotencyConflictError, NotFoundError } from '../../domain/errors.js';
import { deterministicFinancialId } from '../../domain/models/financial-journal.js';
import {
  beginProcessing,
  createPayout,
  markPayoutFailed,
  markPayoutPaid,
} from '../../domain/models/payout.js';
import { requireOrgAccess } from '../context.js';

import { createFinanceService } from './finance-service.js';
import { FinancialPostingService } from './financial-posting-service.js';

import type { EntityId } from '../../domain/identity.js';
import type { Payout, PayoutTransferEvidence } from '../../domain/models/payout.js';
import type {
  BankAccountRepository,
  LedgerRepository,
  FinancialJournalRepository,
  EventRepository,
  JournalTransitionRepository,
  PlatformSettingsRepository,
  PayoutRepository,
  ReconciliationRepository,
} from '../../domain/ports/repositories.js';
import type { ServiceDeps, ActorContext } from '../context.js';

/**
 * ─── Payout Service (Phase 6) ───────────────────────────────────────────────────
 *
 * Draws down a partner's ledger-computed available balance to their default
 * (or a chosen) bank account. Enforces the ₹100 minimum in the domain model
 * (`createPayout`) and never lets requested payouts exceed available balance.
 */

export interface PayoutServiceDeps {
  payouts: PayoutRepository;
  bankAccounts: BankAccountRepository;
  ledger: LedgerRepository;
  financialJournals: FinancialJournalRepository;
  journalTransition: JournalTransitionRepository;
  events: EventRepository;
  reconciliations: ReconciliationRepository;
  platformSettings: PlatformSettingsRepository;
  config: ServiceDeps['config'];
}

export interface RequestPayoutInput {
  organizationId: EntityId;
  amount: number; // paise
  bankAccountId?: EntityId; // defaults to the org's default account
  idempotencyKey: string;
}

export interface PayoutService {
  requestPayout(input: RequestPayoutInput, actor: ActorContext): Promise<Payout>;
  /** Operator action: moves a requested payout into processing. */
  beginProcessingPayout(payoutId: EntityId, actor: ActorContext): Promise<Payout>;
  /** Operator action: marks a processing payout as paid. */
  completePayout(
    payoutId: EntityId,
    evidence: Omit<PayoutTransferEvidence, 'approvedBy'>,
    actor: ActorContext,
  ): Promise<Payout>;
  /** Operator action: marks a payout failed with a reason. */
  failPayout(payoutId: EntityId, reason: string, actor: ActorContext): Promise<Payout>;
  listPayouts(
    organizationId: EntityId,
    actor: ActorContext,
    query: { cursor?: string | null; limit: number },
  ): Promise<{ items: Payout[]; total: number; nextCursor: string | null }>;
  getPayout(payoutId: EntityId, actor: ActorContext): Promise<Payout | null>;
}

export function createPayoutService(deps: PayoutServiceDeps): PayoutService {
  const { payouts, bankAccounts, config } = deps;
  const posting = new FinancialPostingService(deps.financialJournals);
  const finance = createFinanceService({
    ledger: deps.ledger,
    financialJournals: deps.financialJournals,
    journalTransition: deps.journalTransition,
    payouts: deps.payouts,
    events: deps.events,
    reconciliations: deps.reconciliations,
    config: deps.config,
  });

  async function requestPayout(input: RequestPayoutInput, actor: ActorContext): Promise<Payout> {
    requireOrgAccess(actor, input.organizationId);

    const bankAccount = input.bankAccountId
      ? await bankAccounts.findById(input.bankAccountId)
      : await bankAccounts.findDefaultByOrganization(input.organizationId);
    if (!bankAccount) throw new NotFoundError('BankAccount', input.bankAccountId ?? 'default');
    if (bankAccount.organizationId !== input.organizationId) {
      throw new ForbiddenError('Bank account does not belong to this organization');
    }

    const payoutId = deterministicFinancialId(
      'payout',
      `${input.organizationId}:${input.idempotencyKey}`,
    );
    const replay = await payouts.findById(payoutId);
    if (replay) {
      if (
        replay.organizationId !== input.organizationId ||
        replay.bankAccountId !== bankAccount.id ||
        replay.amount !== input.amount ||
        replay.requestedBy !== actor.userId
      ) {
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      return replay;
    }

    const balance = await finance.getBalances(input.organizationId, actor);
    const payableLimit = balance.availablePaise + balance.reservedPaise + balance.paidPaise;

    const payout = createPayout({
      id: payoutId,
      organizationId: input.organizationId,
      bankAccountId: bankAccount.id,
      amount: input.amount,
      requestedBy: actor.userId,
      now: config.clock.now(),
    });
    const settings = await deps.platformSettings.get();
    const reservation = posting.buildPayoutReservation({
      organizationId: payout.organizationId,
      payoutId: payout.id,
      amountPaise: payout.amount,
      policy: {
        ...settings.accountingPolicy,
        capturedAt: payout.createdAt,
      },
      postedAt: new Date(payout.createdAt),
    });
    return payouts.createWithinLimit(payout, payableLimit, reservation);
  }

  async function beginProcessingPayout(payoutId: EntityId, actor: ActorContext): Promise<Payout> {
    const payout = await payouts.findById(payoutId);
    if (!payout) throw new NotFoundError('Payout', payoutId);
    requireOrgAccess(actor, payout.organizationId);
    return payouts.save(beginProcessing(payout, config.clock.now()));
  }

  async function completePayout(
    payoutId: EntityId,
    evidence: Omit<PayoutTransferEvidence, 'approvedBy'>,
    actor: ActorContext,
  ): Promise<Payout> {
    const payout = await payouts.findById(payoutId);
    if (!payout) throw new NotFoundError('Payout', payoutId);
    requireOrgAccess(actor, payout.organizationId);
    const paid = markPayoutPaid(
      payout,
      { ...evidence, approvedBy: actor.userId },
      config.clock.now(),
    );
    await posting.postPayoutCompletion({
      organizationId: payout.organizationId,
      payoutId: payout.id,
      amountPaise: payout.amount,
      transferReference: paid.transferReference ?? evidence.transferReference,
      postedAt: config.clock.now(),
    });
    return payouts.save(paid);
  }

  async function failPayout(
    payoutId: EntityId,
    reason: string,
    actor: ActorContext,
  ): Promise<Payout> {
    const payout = await payouts.findById(payoutId);
    if (!payout) throw new NotFoundError('Payout', payoutId);
    requireOrgAccess(actor, payout.organizationId);
    const failed = markPayoutFailed(payout, reason, config.clock.now());
    await posting.postPayoutFailureReversal({
      organizationId: payout.organizationId,
      payoutId: payout.id,
      postedAt: config.clock.now(),
    });
    return payouts.save(failed);
  }

  async function listPayouts(
    organizationId: EntityId,
    actor: ActorContext,
    query: { cursor?: string | null; limit: number },
  ): Promise<{ items: Payout[]; total: number; nextCursor: string | null }> {
    requireOrgAccess(actor, organizationId);
    return payouts.listByOrganization(organizationId, query);
  }

  async function getPayout(payoutId: EntityId, actor: ActorContext): Promise<Payout | null> {
    const payout = await payouts.findById(payoutId);
    if (!payout) return null;
    requireOrgAccess(actor, payout.organizationId);
    return payout;
  }

  return {
    requestPayout,
    beginProcessingPayout,
    completePayout,
    failPayout,
    listPayouts,
    getPayout,
  };
}
