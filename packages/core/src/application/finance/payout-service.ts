import { ForbiddenError, InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import {
  beginProcessing,
  createPayout,
  markPayoutFailed,
  markPayoutPaid,
} from '../../domain/models/payout.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { Payout } from '../../domain/models/payout.js';
import type {
  BankAccountRepository,
  LedgerRepository,
  PayoutRepository,
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
  config: ServiceDeps['config'];
}

export interface RequestPayoutInput {
  organizationId: EntityId;
  amount: number; // paise
  bankAccountId?: EntityId; // defaults to the org's default account
}

export interface PayoutService {
  requestPayout(input: RequestPayoutInput, actor: ActorContext): Promise<Payout>;
  /** Operator action: moves a requested payout into processing. */
  beginProcessingPayout(payoutId: EntityId, actor: ActorContext): Promise<Payout>;
  /** Operator action: marks a processing payout as paid. */
  completePayout(payoutId: EntityId, actor: ActorContext): Promise<Payout>;
  /** Operator action: marks a payout failed with a reason. */
  failPayout(payoutId: EntityId, reason: string, actor: ActorContext): Promise<Payout>;
  listPayouts(
    organizationId: EntityId,
    actor: ActorContext,
    query: { cursor?: string | null; limit: number },
  ): Promise<{ items: Payout[]; total: number; nextCursor: string | null }>;
  getPayout(payoutId: EntityId, actor: ActorContext): Promise<Payout | null>;
}

async function availableBalance(
  ledger: LedgerRepository,
  payouts: PayoutRepository,
  organizationId: EntityId,
): Promise<number> {
  const sums = await ledger.sumByOrganizationAndType(organizationId);
  let settled = 0;
  for (const entryType of ['host_payout', 'venue_share', 'promoter_commission'] as const) {
    settled += sums[entryType].settled;
  }
  const [paidOut, reserved] = await Promise.all([
    payouts.sumPaidByOrganization(organizationId),
    payouts.sumRequestedOrProcessingByOrganization(organizationId),
  ]);
  return settled - paidOut - reserved;
}

export function createPayoutService(deps: PayoutServiceDeps): PayoutService {
  const { payouts, bankAccounts, ledger, config } = deps;

  async function requestPayout(input: RequestPayoutInput, actor: ActorContext): Promise<Payout> {
    requireOrgAccess(actor, input.organizationId);

    const bankAccount = input.bankAccountId
      ? await bankAccounts.findById(input.bankAccountId)
      : await bankAccounts.findDefaultByOrganization(input.organizationId);
    if (!bankAccount) throw new NotFoundError('BankAccount', input.bankAccountId ?? 'default');
    if (bankAccount.organizationId !== input.organizationId) {
      throw new ForbiddenError('Bank account does not belong to this organization');
    }

    const available = await availableBalance(ledger, payouts, input.organizationId);
    if (input.amount > available) {
      throw new InvalidOperationError(
        `Requested payout ${input.amount} exceeds available balance ${available}`,
      );
    }

    const payout = createPayout({
      organizationId: input.organizationId,
      bankAccountId: bankAccount.id,
      amount: input.amount,
      requestedBy: actor.userId,
      now: config.clock.now(),
    });
    return payouts.create(payout);
  }

  async function beginProcessingPayout(payoutId: EntityId, actor: ActorContext): Promise<Payout> {
    const payout = await payouts.findById(payoutId);
    if (!payout) throw new NotFoundError('Payout', payoutId);
    requireOrgAccess(actor, payout.organizationId);
    return payouts.save(beginProcessing(payout, config.clock.now()));
  }

  async function completePayout(payoutId: EntityId, actor: ActorContext): Promise<Payout> {
    const payout = await payouts.findById(payoutId);
    if (!payout) throw new NotFoundError('Payout', payoutId);
    requireOrgAccess(actor, payout.organizationId);
    return payouts.save(markPayoutPaid(payout, config.clock.now()));
  }

  async function failPayout(
    payoutId: EntityId,
    reason: string,
    actor: ActorContext,
  ): Promise<Payout> {
    const payout = await payouts.findById(payoutId);
    if (!payout) throw new NotFoundError('Payout', payoutId);
    requireOrgAccess(actor, payout.organizationId);
    return payouts.save(markPayoutFailed(payout, reason, config.clock.now()));
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
