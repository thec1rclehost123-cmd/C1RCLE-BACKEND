import { createHash } from 'node:crypto';

import { InvalidOperationError } from '../errors.js';

import type { EntityId } from '../identity.js';

export type CurrencyCode = string;

export interface Money {
  readonly amountPaise: number;
  readonly currency: CurrencyCode;
}

export type DiscountFundingOwner = 'platform' | 'venue' | 'host' | 'promoter' | 'shared';

export interface FinancialComponentBreakdown {
  readonly ticketFaceValuePaise: number;
  readonly discountPaise: number;
  readonly discountFundingOwner: DiscountFundingOwner | null;
  readonly netTicketRevenuePaise: number;
  readonly gstPaise: number;
  readonly platformFeePaise: number;
  readonly paymentFeePaise: number;
  readonly providerFeePaise: number;
  readonly platformAllocationPaise: number;
  readonly hostAllocationPaise: number;
  readonly venueAllocationPaise: number;
  readonly promoterAllocationPaise: number;
  readonly refundPaise: number;
  readonly chargebackPaise: number;
  readonly reservePaise: number;
  readonly payoutPaise: number;
  readonly roundingAdjustmentPaise: number;
}

export interface AccountingPolicySnapshot {
  readonly version: string;
  readonly capturedAt: string;
  readonly settlementDelayDays: number;
  readonly reserveBasisPoints: number;
  readonly requiresEventCompletion: boolean;
  readonly holdsOnCancellation: boolean;
  readonly holdsOnDispute: boolean;
  readonly holdsOnUnresolvedReconciliation: boolean;
}

export const DEFAULT_ACCOUNTING_POLICY: AccountingPolicySnapshot = Object.freeze({
  version: 'm2-test-policy-v1',
  capturedAt: '2026-10-15T00:00:00.000Z',
  settlementDelayDays: 3,
  reserveBasisPoints: 0,
  requiresEventCompletion: true,
  holdsOnCancellation: true,
  holdsOnDispute: true,
  holdsOnUnresolvedReconciliation: true,
});

export type AccountCode =
  | 'provider_clearing'
  | 'cash_bank_clearing'
  | 'customer_refund_liability'
  | 'gst_tax_liability'
  | 'venue_payable'
  | 'host_payable'
  | 'promoter_payable'
  | 'platform_fee_revenue'
  | 'platform_commission_revenue'
  | 'ticket_collection_control'
  | 'provider_fee_expense'
  | 'refund_clearing'
  | 'chargeback_loss_receivable'
  | 'chargeback_reserve'
  | 'payout_clearing'
  | 'rounding_adjustment';

export type JournalSide = 'debit' | 'credit';

export interface JournalLine {
  readonly id: EntityId;
  readonly account: AccountCode;
  readonly side: JournalSide;
  readonly amountPaise: number;
  readonly currency: CurrencyCode;
  readonly organizationId: EntityId | null;
  readonly component: keyof FinancialComponentBreakdown | null;
  readonly memo: string;
}

export type PostingSourceType =
  | 'online_payment_capture'
  | 'free_ticket'
  | 'door_cash_sale'
  | 'door_electronic_sale'
  | 'promo_discount'
  | 'complimentary_ticket'
  | 'void'
  | 'refund'
  | 'chargeback'
  | 'chargeback_reversal'
  | 'reserve'
  | 'reserve_release'
  | 'payout_reservation'
  | 'payout_completion'
  | 'payout_failure_reversal'
  | 'manual_adjustment'
  | 'legacy_backfill';

export interface PostingSource {
  readonly type: PostingSourceType;
  readonly id: EntityId;
  readonly orderId: EntityId | null;
  readonly paymentId: string | null;
  readonly eventId: EntityId | null;
}

export interface FinancialJournal {
  readonly id: EntityId;
  readonly organizationId: EntityId;
  readonly currency: CurrencyCode;
  readonly lines: readonly JournalLine[];
  readonly source: PostingSource;
  readonly idempotencyKey: string;
  readonly accountingPolicy: AccountingPolicySnapshot;
  readonly components: FinancialComponentBreakdown | null;
  readonly reversalOfJournalId: EntityId | null;
  readonly evidenceOnly: boolean;
  readonly status: 'posted';
  readonly postedAt: string;
  readonly createdAt: string;
}

export interface CreateJournalInput {
  readonly organizationId: EntityId;
  readonly currency: CurrencyCode;
  readonly lines: readonly Omit<JournalLine, 'id' | 'currency'>[];
  readonly source: PostingSource;
  readonly idempotencyKey: string;
  readonly accountingPolicy: AccountingPolicySnapshot;
  readonly components?: FinancialComponentBreakdown | null;
  readonly reversalOfJournalId?: EntityId | null;
  readonly evidenceOnly?: boolean;
  readonly postedAt?: Date;
}

function assertPaise(value: number, label: string, allowZero = true): void {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new InvalidOperationError(`${label} must be a non-negative integer number of paise`);
  }
}

export function normalizeCurrency(currency: string): CurrencyCode {
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new InvalidOperationError('Journal currency must be a three-letter ISO code');
  }
  return normalized;
}

export function deterministicFinancialId(prefix: string, value: string): EntityId {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${prefix}-${digest}`;
}

export function journalTotals(journal: Pick<FinancialJournal, 'lines'>): {
  debitPaise: number;
  creditPaise: number;
} {
  return journal.lines.reduce(
    (totals, line) => {
      if (line.side === 'debit') totals.debitPaise += line.amountPaise;
      else totals.creditPaise += line.amountPaise;
      return totals;
    },
    { debitPaise: 0, creditPaise: 0 },
  );
}

export function createPostedJournal(input: CreateJournalInput): FinancialJournal {
  const currency = normalizeCurrency(input.currency);
  if (input.lines.length < 2) {
    throw new InvalidOperationError('A posted journal requires at least two lines');
  }
  if (input.idempotencyKey.trim().length === 0) {
    throw new InvalidOperationError('A posted journal requires an idempotency key');
  }
  if (input.accountingPolicy.version.trim().length === 0) {
    throw new InvalidOperationError('A posted journal requires an accounting policy version');
  }

  const lines = input.lines.map((line, index): JournalLine => {
    assertPaise(line.amountPaise, `Journal line ${String(index + 1)} amount`);
    return Object.freeze({
      ...line,
      id: deterministicFinancialId('jln', `${input.idempotencyKey}:${String(index)}`),
      currency,
    });
  });
  const debitPaise = lines
    .filter((line) => line.side === 'debit')
    .reduce((sum, line) => sum + line.amountPaise, 0);
  const creditPaise = lines
    .filter((line) => line.side === 'credit')
    .reduce((sum, line) => sum + line.amountPaise, 0);
  if (debitPaise !== creditPaise) {
    throw new InvalidOperationError(
      `Journal is not balanced: debit ${String(debitPaise)} != credit ${String(creditPaise)}`,
    );
  }
  if (!input.evidenceOnly && debitPaise === 0) {
    throw new InvalidOperationError('A financial journal must move a positive amount');
  }

  const postedAt = input.postedAt ?? new Date();
  return Object.freeze({
    id: deterministicFinancialId('jnl', input.idempotencyKey),
    organizationId: input.organizationId,
    currency,
    lines: Object.freeze(lines),
    source: Object.freeze({ ...input.source }),
    idempotencyKey: input.idempotencyKey,
    accountingPolicy: Object.freeze({ ...input.accountingPolicy }),
    components: input.components ? Object.freeze({ ...input.components }) : null,
    reversalOfJournalId: input.reversalOfJournalId ?? null,
    evidenceOnly: input.evidenceOnly ?? false,
    status: 'posted' as const,
    postedAt: postedAt.toISOString(),
    createdAt: postedAt.toISOString(),
  });
}

export function createReversalJournal(input: {
  readonly original: FinancialJournal;
  readonly source: PostingSource;
  readonly idempotencyKey: string;
  readonly postedAt?: Date;
}): FinancialJournal {
  return createPostedJournal({
    organizationId: input.original.organizationId,
    currency: input.original.currency,
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    accountingPolicy: input.original.accountingPolicy,
    components: input.original.components,
    reversalOfJournalId: input.original.id,
    postedAt: input.postedAt,
    evidenceOnly: input.original.evidenceOnly,
    lines: input.original.lines.map((line) => ({
      account: line.account,
      side: line.side === 'debit' ? 'credit' : 'debit',
      amountPaise: line.amountPaise,
      organizationId: line.organizationId,
      component: line.component,
      memo: `Reversal: ${line.memo}`,
    })),
  });
}

export function assertFinancialComponents(components: FinancialComponentBreakdown): void {
  for (const [name, amount] of Object.entries(components)) {
    if (name === 'discountFundingOwner') continue;
    assertPaise(amount as number, name);
  }
  if (components.discountPaise > 0 && components.discountFundingOwner === null) {
    throw new InvalidOperationError('A financially effective discount requires a funding owner');
  }
  if (
    components.ticketFaceValuePaise - components.discountPaise !==
    components.netTicketRevenuePaise
  ) {
    throw new InvalidOperationError(
      'Net ticket revenue does not reconcile with face value and discount',
    );
  }
}
