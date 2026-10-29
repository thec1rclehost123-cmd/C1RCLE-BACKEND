import { InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import {
  assertFinancialComponents,
  createPostedJournal,
  createReversalJournal,
  DEFAULT_ACCOUNTING_POLICY,
} from '../../domain/models/financial-journal.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  AccountingPolicySnapshot,
  CurrencyCode,
  DiscountFundingOwner,
  FinancialComponentBreakdown,
  FinancialJournal,
  JournalLine,
  PostingSource,
} from '../../domain/models/financial-journal.js';
import type { FinancialJournalRepository } from '../../domain/ports/repositories.js';

export interface PartnerAllocation {
  readonly platformPaise: number;
  readonly hostOrganizationId: EntityId;
  readonly hostPaise: number;
  readonly venueOrganizationId: EntityId | null;
  readonly venuePaise: number;
  readonly promoterOrganizationId: EntityId | null;
  readonly promoterPaise: number;
}

export interface TicketSalePostingInput {
  readonly organizationId: EntityId;
  readonly orderId: EntityId;
  readonly eventId: EntityId;
  readonly paymentId: string | null;
  readonly sourceType: 'online_payment_capture' | 'door_cash_sale' | 'door_electronic_sale';
  readonly providerConfirmed: boolean;
  readonly currency: CurrencyCode;
  readonly ticketFaceValuePaise: number;
  readonly eventCoverLiabilityPaise?: number;
  readonly discountPaise: number;
  readonly discountFundingOwner: DiscountFundingOwner | null;
  readonly netTicketRevenuePaise: number;
  readonly gstPaise: number;
  readonly platformFeePaise: number;
  readonly paymentFeePaise: number;
  readonly providerFeePaise?: number;
  readonly allocation: PartnerAllocation;
  readonly promoterAssignmentId?: EntityId | null;
  readonly commissionPolicyVersion?: string | null;
  readonly commercialPolicyVersion?: string | null;
  readonly policy?: AccountingPolicySnapshot;
  readonly postedAt?: Date;
}

function line(input: Omit<JournalLine, 'id' | 'currency'>): Omit<JournalLine, 'id' | 'currency'> {
  return input;
}

function nonZero(
  lines: readonly Omit<JournalLine, 'id' | 'currency'>[],
): Omit<JournalLine, 'id' | 'currency'>[] {
  return lines.filter((entry) => entry.amountPaise !== 0);
}

export function buildTicketSaleJournals(input: TicketSalePostingInput): FinancialJournal[] {
  if (input.sourceType === 'door_electronic_sale' && !input.providerConfirmed) {
    throw new InvalidOperationError(
      'An electronic door sale requires provider or terminal confirmation',
    );
  }
  if (input.sourceType === 'online_payment_capture' && !input.providerConfirmed) {
    throw new InvalidOperationError('An online sale requires provider capture confirmation');
  }
  if (input.sourceType !== 'door_cash_sale' && input.paymentId === null) {
    throw new InvalidOperationError('An electronic sale requires a provider payment id');
  }
  const saleComponents: FinancialComponentBreakdown = {
    ticketFaceValuePaise: input.ticketFaceValuePaise,
    eventCoverLiabilityPaise: input.eventCoverLiabilityPaise ?? 0,
    discountPaise: input.discountPaise,
    discountFundingOwner: input.discountFundingOwner,
    netTicketRevenuePaise: input.netTicketRevenuePaise,
    gstPaise: input.gstPaise,
    platformFeePaise: input.platformFeePaise,
    paymentFeePaise: input.paymentFeePaise,
    // Provider fees can arrive after browser fulfilment. They post in their
    // own additive journal and therefore cannot rewrite the already committed
    // collection/allocation evidence.
    providerFeePaise: 0,
    platformAllocationPaise: input.allocation.platformPaise,
    hostAllocationPaise: input.allocation.hostPaise,
    venueAllocationPaise: input.allocation.venuePaise,
    promoterAllocationPaise: input.allocation.promoterPaise,
    refundPaise: 0,
    chargebackPaise: 0,
    reservePaise: 0,
    payoutPaise: 0,
    roundingAdjustmentPaise: 0,
  };
  assertFinancialComponents(saleComponents);

  const allocationTotal =
    input.allocation.platformPaise +
    input.allocation.hostPaise +
    input.allocation.venuePaise +
    input.allocation.promoterPaise;
  const roundingAdjustmentPaise = input.netTicketRevenuePaise - allocationTotal;
  const withRounding = {
    ...saleComponents,
    roundingAdjustmentPaise: Math.abs(roundingAdjustmentPaise),
  };
  const source: PostingSource = {
    type: input.sourceType,
    id: input.orderId,
    orderId: input.orderId,
    paymentId: input.paymentId,
    eventId: input.eventId,
    ...(input.promoterAssignmentId
      ? {
          assignmentId: input.promoterAssignmentId,
          commissionPolicyVersion: input.commissionPolicyVersion ?? null,
          commercialPolicyVersion: input.commercialPolicyVersion ?? null,
        }
      : {}),
  };
  const policy = input.policy ?? DEFAULT_ACCOUNTING_POLICY;
  const clearingAccount =
    input.sourceType === 'door_cash_sale' ? 'cash_bank_clearing' : 'provider_clearing';
  const customerTotal =
    input.netTicketRevenuePaise +
    (input.eventCoverLiabilityPaise ?? 0) +
    input.gstPaise +
    input.platformFeePaise +
    input.paymentFeePaise;

  const collection = createPostedJournal({
    organizationId: input.organizationId,
    currency: input.currency,
    source,
    idempotencyKey: `m2:ticket-sale:${input.orderId}:collection`,
    accountingPolicy: policy,
    components: withRounding,
    postedAt: input.postedAt,
    lines: nonZero([
      line({
        account: clearingAccount,
        side: 'debit',
        amountPaise: customerTotal,
        organizationId: input.organizationId,
        component: null,
        memo: 'Customer payment collected',
      }),
      line({
        account: 'ticket_collection_control',
        side: 'credit',
        amountPaise: input.netTicketRevenuePaise,
        organizationId: input.organizationId,
        component: 'netTicketRevenuePaise',
        memo: 'Discounted ticket face value collected',
      }),
      line({
        account: 'event_cover_liability',
        side: 'credit',
        amountPaise: input.eventCoverLiabilityPaise ?? 0,
        organizationId: input.organizationId,
        component: 'eventCoverLiabilityPaise',
        memo: 'Event cover funds held for entitlement redemption or refund',
      }),
      line({
        account: 'platform_fee_revenue',
        side: 'credit',
        amountPaise: input.platformFeePaise + input.paymentFeePaise,
        organizationId: input.organizationId,
        component: 'platformFeePaise',
        memo: 'Platform and convenience fees collected',
      }),
      line({
        account: 'gst_tax_liability',
        side: 'credit',
        amountPaise: input.gstPaise,
        organizationId: input.organizationId,
        component: 'gstPaise',
        memo: 'GST collected for remittance',
      }),
    ]),
  });

  const allocationLines: Omit<JournalLine, 'id' | 'currency'>[] = [
    line({
      account: 'ticket_collection_control',
      side: 'debit',
      amountPaise: input.netTicketRevenuePaise,
      organizationId: input.organizationId,
      component: 'netTicketRevenuePaise',
      memo: 'Allocate net ticket revenue',
    }),
    line({
      account: 'platform_commission_revenue',
      side: 'credit',
      amountPaise: input.allocation.platformPaise,
      organizationId: input.organizationId,
      component: 'platformAllocationPaise',
      memo: 'Platform commercial allocation',
    }),
    line({
      account: 'host_payable',
      side: 'credit',
      amountPaise: input.allocation.hostPaise,
      organizationId: input.allocation.hostOrganizationId,
      component: 'hostAllocationPaise',
      memo: 'Host payable',
    }),
    line({
      account: 'venue_payable',
      side: 'credit',
      amountPaise: input.allocation.venuePaise,
      organizationId: input.allocation.venueOrganizationId,
      component: 'venueAllocationPaise',
      memo: 'Venue payable',
    }),
    line({
      account: 'promoter_payable',
      side: 'credit',
      amountPaise: input.allocation.promoterPaise,
      organizationId: input.allocation.promoterOrganizationId,
      component: 'promoterAllocationPaise',
      memo: 'Promoter payable',
    }),
  ];
  if (roundingAdjustmentPaise !== 0) {
    allocationLines.push(
      line({
        account: 'rounding_adjustment',
        side: roundingAdjustmentPaise > 0 ? 'credit' : 'debit',
        amountPaise: Math.abs(roundingAdjustmentPaise),
        organizationId: input.organizationId,
        component: 'roundingAdjustmentPaise',
        memo: 'Deterministic allocation rounding adjustment',
      }),
    );
  }
  const allocation = createPostedJournal({
    organizationId: input.organizationId,
    currency: input.currency,
    source,
    idempotencyKey: `m2:ticket-sale:${input.orderId}:allocation`,
    accountingPolicy: policy,
    components: withRounding,
    postedAt: input.postedAt,
    lines: nonZero(allocationLines),
  });

  const journals = [collection, allocation];
  if ((input.providerFeePaise ?? 0) > 0) {
    journals.push(
      createPostedJournal({
        organizationId: input.organizationId,
        currency: input.currency,
        source,
        idempotencyKey: `m2:ticket-sale:${input.orderId}:provider-fee`,
        accountingPolicy: policy,
        components: { ...withRounding, providerFeePaise: input.providerFeePaise ?? 0 },
        postedAt: input.postedAt,
        lines: [
          line({
            account: 'provider_fee_expense',
            side: 'debit',
            amountPaise: input.providerFeePaise ?? 0,
            organizationId: input.organizationId,
            component: 'providerFeePaise',
            memo: 'Provider fee expense',
          }),
          line({
            account: 'provider_clearing',
            side: 'credit',
            amountPaise: input.providerFeePaise ?? 0,
            organizationId: input.organizationId,
            component: 'providerFeePaise',
            memo: 'Provider fee retained from clearing',
          }),
        ],
      }),
    );
  }
  return journals;
}

export function buildZeroValueEvidence(input: {
  readonly organizationId: EntityId;
  readonly orderId: EntityId;
  readonly eventId: EntityId;
  readonly currency: CurrencyCode;
  readonly sourceType: 'free_ticket' | 'complimentary_ticket';
  readonly policy?: AccountingPolicySnapshot;
  readonly postedAt?: Date;
}): FinancialJournal {
  return createPostedJournal({
    organizationId: input.organizationId,
    currency: input.currency,
    source: {
      type: input.sourceType,
      id: input.orderId,
      orderId: input.orderId,
      paymentId: null,
      eventId: input.eventId,
    },
    idempotencyKey: `m2:${input.sourceType}:${input.orderId}`,
    accountingPolicy: input.policy ?? DEFAULT_ACCOUNTING_POLICY,
    evidenceOnly: true,
    postedAt: input.postedAt,
    lines: [
      line({
        account: 'ticket_collection_control',
        side: 'debit',
        amountPaise: 0,
        organizationId: input.organizationId,
        component: null,
        memo: 'Zero-value ticket evidence',
      }),
      line({
        account: 'ticket_collection_control',
        side: 'credit',
        amountPaise: 0,
        organizationId: input.organizationId,
        component: null,
        memo: 'Zero-value ticket evidence',
      }),
    ],
  });
}

export class FinancialPostingService {
  constructor(private readonly journals: FinancialJournalRepository) {}

  postTicketSale(input: TicketSalePostingInput): Promise<FinancialJournal[]> {
    return this.journals.postBatch(buildTicketSaleJournals(input));
  }

  postZeroValueEvidence(
    input: Parameters<typeof buildZeroValueEvidence>[0],
  ): Promise<FinancialJournal[]> {
    return this.journals.postBatch([buildZeroValueEvidence(input)]);
  }

  buildPayoutReservation(input: {
    organizationId: EntityId;
    payoutId: EntityId;
    amountPaise: number;
    policy: AccountingPolicySnapshot;
    postedAt?: Date;
  }): FinancialJournal {
    return createPostedJournal({
      organizationId: input.organizationId,
      currency: 'INR',
      source: {
        type: 'payout_reservation',
        id: input.payoutId,
        orderId: null,
        paymentId: null,
        eventId: null,
      },
      idempotencyKey: `m2:payout:${input.payoutId}:reservation`,
      accountingPolicy: input.policy,
      postedAt: input.postedAt,
      lines: [
        line({
          account: 'partner_payable',
          side: 'debit',
          amountPaise: input.amountPaise,
          organizationId: input.organizationId,
          component: 'payoutPaise',
          memo: 'Reserve partner payable for payout',
        }),
        line({
          account: 'payout_clearing',
          side: 'credit',
          amountPaise: input.amountPaise,
          organizationId: input.organizationId,
          component: 'payoutPaise',
          memo: 'Payout awaiting transfer',
        }),
      ],
    });
  }

  postPayoutReservation(
    input: Parameters<FinancialPostingService['buildPayoutReservation']>[0],
  ): Promise<FinancialJournal[]> {
    return this.journals.postBatch([this.buildPayoutReservation(input)]);
  }

  async postPayoutFailureReversal(input: {
    organizationId: EntityId;
    payoutId: EntityId;
    postedAt?: Date;
  }): Promise<FinancialJournal[]> {
    const [reservation] = await this.journals.findBySource('payout_reservation', input.payoutId);
    if (!reservation) throw new InvalidOperationError('Payout reservation journal is missing');
    return this.journals.postBatch([
      createReversalJournal({
        original: reservation,
        source: {
          type: 'payout_failure_reversal',
          id: input.payoutId,
          orderId: null,
          paymentId: null,
          eventId: null,
        },
        idempotencyKey: `m2:payout:${input.payoutId}:failure-reversal`,
        postedAt: input.postedAt,
      }),
    ]);
  }

  async postPayoutCompletion(input: {
    organizationId: EntityId;
    payoutId: EntityId;
    amountPaise: number;
    transferReference: string;
    postedAt?: Date;
  }): Promise<FinancialJournal[]> {
    const [reservation] = await this.journals.findBySource('payout_reservation', input.payoutId);
    if (!reservation) throw new InvalidOperationError('Payout reservation journal is missing');
    return this.journals.postBatch([
      createPostedJournal({
        organizationId: input.organizationId,
        currency: reservation.currency,
        source: {
          type: 'payout_completion',
          id: input.payoutId,
          orderId: null,
          paymentId: null,
          eventId: null,
        },
        idempotencyKey: `m2:payout:${input.payoutId}:completion`,
        accountingPolicy: reservation.accountingPolicy,
        postedAt: input.postedAt,
        lines: [
          line({
            account: 'payout_clearing',
            side: 'debit',
            amountPaise: input.amountPaise,
            organizationId: input.organizationId,
            component: 'payoutPaise',
            memo: `Complete payout ${input.transferReference}`,
          }),
          line({
            account: 'cash_bank_clearing',
            side: 'credit',
            amountPaise: input.amountPaise,
            organizationId: input.organizationId,
            component: 'payoutPaise',
            memo: 'Manual bank transfer completed',
          }),
        ],
      }),
    ]);
  }

  async postRefund(input: {
    readonly organizationId: EntityId;
    readonly orderId: EntityId;
    readonly eventId: EntityId;
    readonly paymentId: string;
    readonly refundRequestId: EntityId;
    readonly providerRefundId: string;
    readonly amountPaise: number;
    readonly previouslyRefundedPaise: number;
    readonly postedAt?: Date;
  }): Promise<FinancialJournal[]> {
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
      throw new InvalidOperationError('Refund amount must be positive integer paise');
    }
    const saleJournals = (
      await Promise.all(
        (['online_payment_capture', 'door_cash_sale', 'door_electronic_sale'] as const).map(
          (sourceType) => this.journals.findBySource(sourceType, input.orderId),
        ),
      )
    ).flat();
    const collection = saleJournals.find((journal) =>
      journal.idempotencyKey.endsWith(':collection'),
    );
    const allocation = saleJournals.find((journal) =>
      journal.idempotencyKey.endsWith(':allocation'),
    );
    if (!collection || !allocation || !collection.components) {
      throw new InvalidOperationError('Refund requires the original posted sale journals');
    }
    const collectedCredits = collection.lines.filter((entry) => entry.side === 'credit');
    const priorRefundJournals = (await this.journals.findByOrderId(input.orderId)).filter(
      (journal) => journal.source.type === 'refund' && journal.source.id !== input.refundRequestId,
    );
    const lineKey = (entry: Pick<JournalLine, 'account' | 'organizationId' | 'component'>) =>
      `${entry.account}|${entry.organizationId ?? ''}|${entry.component ?? ''}`;
    const consumedByKey = (suffix: ':recognition' | ':payable-reversal'): Map<string, number> => {
      const consumed = new Map<string, number>();
      for (const journal of priorRefundJournals.filter((item) =>
        item.idempotencyKey.endsWith(suffix),
      )) {
        for (const entry of journal.lines.filter((item) => item.side === 'debit')) {
          const key = lineKey(entry);
          consumed.set(key, (consumed.get(key) ?? 0) + entry.amountPaise);
        }
      }
      return consumed;
    };
    const customerTotal = collectedCredits.reduce((sum, entry) => sum + entry.amountPaise, 0);
    if (input.previouslyRefundedPaise + input.amountPaise > customerTotal) {
      throw new InvalidOperationError('Refund exceeds the original customer payment');
    }
    const collectionWeights = collectedCredits.map((entry) => entry.amountPaise);
    const recognizedConsumed = consumedByKey(':recognition');
    const recognizedPrevious = collectedCredits.map(
      (entry) => recognizedConsumed.get(lineKey(entry)) ?? 0,
    );
    const recognized = allocateProRata(
      input.amountPaise,
      collectionWeights.map((weight, index) => weight - (recognizedPrevious[index] ?? 0)),
    );
    const refundedTicketRevenue = collectedCredits.reduce(
      (sum, entry, index) =>
        entry.account === 'ticket_collection_control' ? sum + (recognized[index] ?? 0) : sum,
      0,
    );
    const components: FinancialComponentBreakdown = {
      ...collection.components,
      refundPaise: input.amountPaise,
    };
    const source: PostingSource = {
      type: 'refund',
      id: input.refundRequestId,
      orderId: input.orderId,
      paymentId: input.paymentId,
      eventId: input.eventId,
    };
    const journals: FinancialJournal[] = [
      createPostedJournal({
        organizationId: input.organizationId,
        currency: collection.currency,
        source,
        idempotencyKey: `m2:refund:${input.refundRequestId}:recognition`,
        accountingPolicy: collection.accountingPolicy,
        components,
        postedAt: input.postedAt,
        lines: [
          ...collectedCredits.map((entry, index) =>
            line({
              account: entry.account,
              side: 'debit',
              amountPaise: recognized[index] ?? 0,
              organizationId: entry.organizationId,
              component: entry.component,
              memo: `Refund reversal: ${entry.memo}`,
            }),
          ),
          line({
            account: 'customer_refund_liability',
            side: 'credit',
            amountPaise: input.amountPaise,
            organizationId: input.organizationId,
            component: 'refundPaise',
            memo: 'Approved customer refund liability',
          }),
        ].filter((entry) => entry.amountPaise > 0),
      }),
    ];

    if (refundedTicketRevenue > 0) {
      const allocatedCredits = allocation.lines.filter((entry) => entry.side === 'credit');
      const allocationWeights = allocatedCredits.map((entry) => entry.amountPaise);
      const reversedConsumed = consumedByKey(':payable-reversal');
      const reversedPrevious = allocatedCredits.map(
        (entry) => reversedConsumed.get(lineKey(entry)) ?? 0,
      );
      const reversedAllocations = allocateProRata(
        refundedTicketRevenue,
        allocationWeights.map((weight, index) => weight - (reversedPrevious[index] ?? 0)),
      );
      journals.push(
        createPostedJournal({
          organizationId: input.organizationId,
          currency: collection.currency,
          source,
          idempotencyKey: `m2:refund:${input.refundRequestId}:payable-reversal`,
          accountingPolicy: collection.accountingPolicy,
          components,
          postedAt: input.postedAt,
          lines: [
            ...allocatedCredits.map((entry, index) =>
              line({
                account: entry.account,
                side: 'debit',
                amountPaise: reversedAllocations[index] ?? 0,
                organizationId: entry.organizationId,
                component: entry.component,
                memo: `Refund payable reversal: ${entry.memo}`,
              }),
            ),
            line({
              account: 'ticket_collection_control',
              side: 'credit',
              amountPaise: refundedTicketRevenue,
              organizationId: input.organizationId,
              component: 'refundPaise',
              memo: 'Reverse refunded ticket allocation',
            }),
          ].filter((entry) => entry.amountPaise > 0),
        }),
      );
    }

    journals.push(
      createPostedJournal({
        organizationId: input.organizationId,
        currency: collection.currency,
        source,
        idempotencyKey: `m2:refund:${input.refundRequestId}:provider-settlement`,
        accountingPolicy: collection.accountingPolicy,
        components,
        postedAt: input.postedAt,
        lines: [
          line({
            account: 'customer_refund_liability',
            side: 'debit',
            amountPaise: input.amountPaise,
            organizationId: input.organizationId,
            component: 'refundPaise',
            memo: `Provider refund ${input.providerRefundId} processed`,
          }),
          line({
            account:
              collection.source.type === 'door_cash_sale'
                ? 'cash_bank_clearing'
                : 'provider_clearing',
            side: 'credit',
            amountPaise: input.amountPaise,
            organizationId: input.organizationId,
            component: 'refundPaise',
            memo: 'Refund paid to customer',
          }),
        ],
      }),
    );
    return this.journals.postBatch(journals);
  }

  /** Reserve disputed funds against future payable before the provider outcome. */
  async postChargebackHold(input: ChargebackPostingInput): Promise<FinancialJournal[]> {
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
      throw new InvalidOperationError('Chargeback amount must be positive integer paise');
    }
    const saleJournals = await this.journals.findByOrderId(input.orderId);
    const allocation = saleJournals.find((journal) =>
      journal.idempotencyKey.endsWith(':allocation'),
    );
    const collection = saleJournals.find((journal) =>
      journal.idempotencyKey.endsWith(':collection'),
    );
    if (!allocation || !collection) {
      throw new InvalidOperationError('Chargeback requires the original posted sale journals');
    }
    const allocationCredits = collection.accountingPolicy.holdsOnDispute
      ? allocation.lines.filter((entry) => entry.side === 'credit')
      : [];
    const allocationTotal = allocationCredits.reduce((sum, entry) => sum + entry.amountPaise, 0);
    const recoverable = Math.min(input.amountPaise, allocationTotal);
    const allocated =
      recoverable === 0
        ? allocationCredits.map(() => 0)
        : allocateProRata(
            recoverable,
            allocationCredits.map((entry) => entry.amountPaise),
          );
    const platformExposure = input.amountPaise - recoverable;
    const source: PostingSource = {
      type: 'chargeback',
      id: input.disputeId,
      orderId: input.orderId,
      paymentId: input.paymentId,
      eventId: input.eventId,
    };
    return this.journals.postBatch([
      createPostedJournal({
        organizationId: input.organizationId,
        currency: collection.currency,
        source,
        idempotencyKey: `m2:chargeback:${input.disputeId}:hold`,
        accountingPolicy: collection.accountingPolicy,
        components: collection.components
          ? {
              ...collection.components,
              chargebackPaise: input.amountPaise,
              reservePaise: input.amountPaise,
            }
          : null,
        postedAt: input.postedAt,
        lines: [
          ...allocationCredits.map((entry, index) =>
            line({
              account: entry.account,
              side: 'debit',
              amountPaise: allocated[index] ?? 0,
              organizationId: entry.organizationId,
              component: 'reservePaise',
              memo: `Chargeback hold: ${entry.memo}`,
            }),
          ),
          line({
            account: 'chargeback_loss_receivable',
            side: 'debit',
            amountPaise: platformExposure,
            organizationId: input.organizationId,
            component: 'chargebackPaise',
            memo: 'Chargeback exposure above partner allocation',
          }),
          line({
            account: 'chargeback_reserve',
            side: 'credit',
            amountPaise: input.amountPaise,
            organizationId: input.organizationId,
            component: 'reservePaise',
            memo: 'Provider dispute reserve',
          }),
        ].filter((entry) => entry.amountPaise > 0),
      }),
    ]);
  }

  async settleChargebackLoss(input: ChargebackPostingInput): Promise<FinancialJournal[]> {
    const [hold] = await this.postChargebackHold(input);
    if (!hold) throw new InvalidOperationError('Chargeback hold was not posted');
    const deductedPaise = input.providerDeductedPaise ?? input.amountPaise;
    if (deductedPaise !== input.amountPaise) {
      throw new InvalidOperationError('Partial provider dispute deductions require reconciliation');
    }
    return this.journals.postBatch([
      createPostedJournal({
        organizationId: input.organizationId,
        currency: hold.currency,
        source: { ...hold.source, type: 'chargeback_loss' },
        idempotencyKey: `m2:chargeback:${input.disputeId}:provider-deduction`,
        accountingPolicy: hold.accountingPolicy,
        components: hold.components,
        postedAt: input.postedAt,
        lines: [
          line({
            account: 'chargeback_reserve',
            side: 'debit',
            amountPaise: deductedPaise,
            organizationId: input.organizationId,
            component: 'chargebackPaise',
            memo: 'Chargeback loss confirmed',
          }),
          line({
            account: 'provider_clearing',
            side: 'credit',
            amountPaise: deductedPaise,
            organizationId: input.organizationId,
            component: 'chargebackPaise',
            memo: 'Provider deducted chargeback',
          }),
          line({
            account: 'partner_payable',
            side: 'debit',
            amountPaise: 0,
            organizationId: input.organizationId,
            component: null,
            memo: 'Chargeback hold converted to confirmed loss',
          }),
        ],
      }),
    ]);
  }

  async releaseChargebackHold(input: ChargebackPostingInput): Promise<FinancialJournal[]> {
    const [hold] = await this.postChargebackHold(input);
    if (!hold) throw new InvalidOperationError('Chargeback hold was not posted');
    return this.journals.postBatch([
      createReversalJournal({
        original: hold,
        source: { ...hold.source, type: 'chargeback_reversal' },
        idempotencyKey: `m2:chargeback:${input.disputeId}:hold-release`,
        postedAt: input.postedAt,
      }),
    ]);
  }

  async reverseJournal(input: {
    readonly journalId: EntityId;
    readonly source: PostingSource;
    readonly idempotencyKey: string;
    readonly postedAt?: Date;
  }): Promise<FinancialJournal> {
    const original = await this.journals.findById(input.journalId);
    if (!original) throw new NotFoundError('Journal', input.journalId);
    const [posted] = await this.journals.postBatch([
      createReversalJournal({
        original,
        source: input.source,
        idempotencyKey: input.idempotencyKey,
        postedAt: input.postedAt,
      }),
    ]);
    if (!posted) throw new InvalidOperationError('Journal repository returned no reversal');
    return posted;
  }

  postManualAdjustment(input: {
    readonly organizationId: EntityId;
    readonly adjustmentId: EntityId;
    readonly amountPaise: number;
    readonly direction: 'credit' | 'debit';
    readonly reason: string;
    readonly actorId: EntityId;
    readonly policy: AccountingPolicySnapshot;
    readonly postedAt?: Date;
  }): Promise<FinancialJournal[]> {
    const reason = input.reason.trim();
    if (!reason) throw new InvalidOperationError('A manual adjustment requires a reason');
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
      throw new InvalidOperationError('A manual adjustment requires positive integer paise');
    }
    const payableSide = input.direction === 'credit' ? 'credit' : 'debit';
    const controlSide = payableSide === 'credit' ? 'debit' : 'credit';
    return this.journals.postBatch([
      createPostedJournal({
        organizationId: input.organizationId,
        currency: 'INR',
        source: {
          type: 'manual_adjustment',
          id: input.adjustmentId,
          orderId: null,
          paymentId: null,
          eventId: null,
        },
        idempotencyKey: `m2:manual-adjustment:${input.adjustmentId}`,
        accountingPolicy: input.policy,
        postedAt: input.postedAt,
        lines: [
          line({
            account: 'manual_adjustment_control',
            side: controlSide,
            amountPaise: input.amountPaise,
            organizationId: input.organizationId,
            component: null,
            memo: `Manual adjustment control: ${reason} (${input.actorId})`,
          }),
          line({
            account: 'partner_payable',
            side: payableSide,
            amountPaise: input.amountPaise,
            organizationId: input.organizationId,
            component: null,
            memo: `Manual partner payable adjustment: ${reason}`,
          }),
        ],
      }),
    ]);
  }
}

interface ChargebackPostingInput {
  organizationId: EntityId;
  orderId: EntityId;
  eventId: EntityId;
  paymentId: string;
  disputeId: string;
  amountPaise: number;
  providerDeductedPaise?: number;
  postedAt?: Date;
}

/** Largest-remainder integer allocation with stable index tie-breaking. */
function allocateProRata(amountPaise: number, weights: readonly number[]): number[] {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) throw new InvalidOperationError('Cannot allocate across zero weight');
  const exact = weights.map((weight) => (amountPaise * weight) / totalWeight);
  const allocated = exact.map(Math.floor);
  let remainder = amountPaise - allocated.reduce((sum, amount) => sum + amount, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (const candidate of order) {
    if (remainder === 0) break;
    allocated[candidate.index] = (allocated[candidate.index] ?? 0) + 1;
    remainder -= 1;
  }
  return allocated;
}
