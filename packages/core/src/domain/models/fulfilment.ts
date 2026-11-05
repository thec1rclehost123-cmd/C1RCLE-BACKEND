import { ConflictError } from '../errors.js';
import { deterministicDomainEventId } from '../events.js';
import { bumpVersion } from '../identity.js';

import { issueEntitlements } from './entitlement.js';
import { journalTotals } from './financial-journal.js';
import { bookingReferenceForOrderId } from './order.js';

import type { EventPayloads, DomainEvent } from '../events.js';
import type { CartReservation } from './cart-reservation.js';
import type { Entitlement } from './entitlement.js';
import type { Event } from './event.js';
import type { FinancialJournal } from './financial-journal.js';
import type { LedgerEntry } from './ledger.js';
import type { Order } from './order.js';
import type { ProviderPayment } from './provider-payment.js';

export interface OrderReceiptFacts {
  version: 'm4-paid-receipt-v1';
  orderId: string;
  bookingReference: string;
  currency: string;
  subtotalPaise: number;
  discountPaise: number;
  discountedSubtotalPaise: number;
  admissionPaise: number;
  coverPaise: number;
  addOnPaise: number;
  platformFeePaise: number;
  paymentFeePaise: number;
  feeTaxPaise: number;
  grandTotalPaise: number;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  paidAt: string | null;
  bookingFeePolicyVersion: string | null;
  accountingPolicyVersion: string | null;
}

export function orderReceiptFacts(order: Order): OrderReceiptFacts {
  return {
    version: 'm4-paid-receipt-v1',
    orderId: order.id,
    bookingReference: order.bookingReference ?? bookingReferenceForOrderId(order.id),
    currency: order.currency,
    subtotalPaise: order.subtotalPaise,
    discountPaise: order.discountPaise,
    discountedSubtotalPaise: order.discountedSubtotalPaise,
    admissionPaise: order.discountedAdmissionSubtotalPaise ?? order.discountedSubtotalPaise,
    coverPaise: order.coverSubtotalPaise ?? 0,
    addOnPaise: order.addOnSubtotalPaise ?? 0,
    platformFeePaise: order.platformFeePaise,
    paymentFeePaise: order.paymentFeePaise,
    feeTaxPaise: order.gstPaise,
    grandTotalPaise: order.grandTotalPaise,
    providerOrderId: order.paymentIntentId,
    providerPaymentId: order.paymentId,
    paidAt: order.paidAt,
    bookingFeePolicyVersion: order.feePolicy?.version ?? null,
    accountingPolicyVersion: order.accountingPolicy?.version ?? null,
  };
}

export interface FulfilmentCompletionInput {
  orderId: string;
  holdId: string;
  event: DomainEvent<EventPayloads['order.fulfilled']>;
  now: Date;
}

export function fulfilmentPending(ticket: Entitlement, order: Order | null): boolean {
  return (
    ticket.fulfillmentRequired === true &&
    (!order ||
      order.id !== ticket.orderId ||
      order.eventId !== ticket.eventId ||
      order.organizationId !== ticket.organizationId ||
      order.fulfillmentState !== 'complete')
  );
}

/** Validates complete sale accounting, including both canonical mandatory journals. */
export function saleAccountingComplete(
  order: Order,
  ledger: LedgerEntry[],
  journals: FinancialJournal[],
): boolean {
  if (order.grandTotalPaise === 0) return true;
  if (
    !['ticket_revenue', 'host_payout'].every((type) =>
      ledger.some(
        (row) =>
          row.orderId === order.id && row.eventId === order.eventId && row.entryType === type,
      ),
    )
  )
    return false;
  const required = ['collection', 'allocation'].map((kind) =>
    journals.find((journal) => journal.idempotencyKey === `m2:ticket-sale:${order.id}:${kind}`),
  );
  if (required.some((journal) => !journal)) return false;
  const allocation = required[1];
  const expectedLedger = new Map<string, number>([
    ['ticket_revenue', order.discountedAdmissionSubtotalPaise ?? order.discountedSubtotalPaise],
    [
      'platform_fee',
      allocation?.lines
        .filter((line) => line.account === 'platform_commission_revenue' && line.side === 'credit')
        .reduce((sum, line) => sum + line.amountPaise, 0) ?? 0,
    ],
    [
      'host_payout',
      allocation?.lines
        .filter((line) => line.account === 'host_payable' && line.side === 'credit')
        .reduce((sum, line) => sum + line.amountPaise, 0) ?? 0,
    ],
    [
      'venue_share',
      allocation?.lines
        .filter((line) => line.account === 'venue_payable' && line.side === 'credit')
        .reduce((sum, line) => sum + line.amountPaise, 0) ?? 0,
    ],
  ]);
  const promoter =
    allocation?.lines
      .filter((line) => line.account === 'promoter_payable' && line.side === 'credit')
      .reduce((sum, line) => sum + line.amountPaise, 0) ?? 0;
  if (promoter > 0) expectedLedger.set('promoter_commission', promoter);
  if (
    [...expectedLedger].some(([type, amount]) => {
      const rows = ledger.filter(
        (row) =>
          row.orderId === order.id && row.eventId === order.eventId && row.entryType === type,
      );
      return rows.length !== 1 || rows[0]?.amount !== amount;
    })
  )
    return false;
  return originalSaleJournalsComplete(order, journals);
}

/** Original capture accounting proof, independent of later refunds or admission state. */
export function originalSaleJournalsComplete(order: Order, journals: FinancialJournal[]): boolean {
  if (order.grandTotalPaise === 0) return true;
  const required = ['collection', 'allocation'].map((kind) =>
    journals.find((journal) => journal.idempotencyKey === `m2:ticket-sale:${order.id}:${kind}`),
  );
  if (required.some((journal) => !journal)) return false;
  return required.every((journal) => {
    if (
      !journal ||
      journal.source.orderId !== order.id ||
      journal.source.id !== order.id ||
      journal.source.eventId !== order.eventId ||
      journal.source.paymentId !== order.paymentId ||
      journal.organizationId !== order.organizationId ||
      journal.currency !== order.currency ||
      journal.status !== 'posted' ||
      journal.lines.length < 2
    )
      return false;
    const totals = journalTotals(journal);
    if (
      totals.debitPaise !== totals.creditPaise ||
      journal.lines.some(
        (line) =>
          line.currency !== order.currency ||
          !Number.isSafeInteger(line.amountPaise) ||
          line.amountPaise < 0,
      )
    )
      return false;
    return (
      !journal.idempotencyKey.endsWith(':collection') ||
      journal.lines.some(
        (line) =>
          line.side === 'debit' &&
          line.account === 'provider_clearing' &&
          line.amountPaise === order.grandTotalPaise,
      )
    );
  });
}

export function completeOrderFulfilment(
  input: FulfilmentCompletionInput,
  evidence: {
    order: Order | null;
    hold: CartReservation | null;
    tickets: Entitlement[];
    issuanceEvents: DomainEvent[];
    ledger: LedgerEntry[];
    journals: FinancialJournal[];
    providerPayment: ProviderPayment | null;
    event: Event | null;
  },
): Order {
  const { order, hold, tickets, issuanceEvents, ledger, journals, providerPayment } = evidence;
  if (
    !order ||
    order.compensationRequired ||
    order.id !== input.orderId ||
    order.status !== 'paid' ||
    !hold ||
    hold.id !== input.holdId ||
    hold.status !== 'converted' ||
    hold.convertedOrderId !== order.id ||
    hold.eventId !== order.eventId ||
    hold.organizationId !== order.organizationId ||
    hold.userId !== order.userId ||
    hold.providerOrderId !== order.paymentIntentId ||
    hold.pricing.grandTotalPaise !== order.grandTotalPaise ||
    hold.pricing.currency !== order.currency
  )
    throw new ConflictError('Fulfillment is missing its exact converted hold');
  if (
    !providerPayment ||
    providerPayment.id !== order.paymentId ||
    providerPayment.providerOrderId !== order.paymentIntentId ||
    providerPayment.currency !== order.currency ||
    (providerPayment.orderId !== null && providerPayment.orderId !== order.id) ||
    ['requires_support', 'refunded'].includes(providerPayment.processingState) ||
    providerPayment.capturedPaise !== order.grandTotalPaise ||
    Object.values(providerPayment.refunds).some((amount) => amount > 0)
  )
    throw new ConflictError('Fulfillment is missing matching provider capture evidence');
  if (
    !evidence.event ||
    evidence.event.id !== order.eventId ||
    evidence.event.organizationId !== order.organizationId ||
    evidence.event.status === 'cancelled'
  )
    throw new ConflictError('The event changed before purchase completion');
  const expected = issueEntitlements({ order });
  if (
    tickets.length !== expected.length ||
    expected.some((wanted) => {
      const ticket = tickets.find((candidate) => candidate.id === wanted.id);
      const issuance = issuanceEvents.find(
        (event) => event.id === deterministicDomainEventId('ticket.issued', wanted.id),
      );
      return (
        !ticket ||
        ticket.orderId !== order.id ||
        ticket.eventId !== order.eventId ||
        ticket.organizationId !== order.organizationId ||
        ticket.tierId !== wanted.tierId ||
        (order.fulfillmentState !== undefined && ticket.fulfillmentRequired !== true) ||
        !issuance ||
        issuance.type !== 'ticket.issued' ||
        issuance.aggregateId !== ticket.id ||
        issuance.organizationId !== order.organizationId ||
        issuance.payload.entitlementId !== ticket.id ||
        issuance.payload.orderId !== order.id ||
        issuance.payload.eventId !== order.eventId ||
        issuance.payload.purchaserUserId !== order.userId ||
        issuance.payload.holderUserId !== (wanted.currentHolderUserId ?? null)
      );
    })
  )
    throw new ConflictError('Fulfillment is missing exact tickets or issuance intents');
  if (!saleAccountingComplete(order, ledger, journals))
    throw new ConflictError('Fulfillment accounting is incomplete');
  const providerFee = providerPayment.feePaise + providerPayment.taxOnFeePaise;
  if (
    providerFee > 0 &&
    !journals.some(
      (journal) =>
        journal.idempotencyKey === `m2:ticket-sale:${order.id}:provider-fee` &&
        journal.source.paymentId === order.paymentId &&
        journal.currency === order.currency &&
        journal.lines.some(
          (line) =>
            line.account === 'provider_fee_expense' &&
            line.side === 'debit' &&
            line.amountPaise === providerFee,
        ) &&
        journalTotals(journal).debitPaise === journalTotals(journal).creditPaise,
    )
  )
    throw new ConflictError('Provider fee accounting is incomplete');
  const event = input.event;
  const receipt = orderReceiptFacts(order);
  if (
    event.id !== deterministicDomainEventId('order.fulfilled', order.id) ||
    event.type !== 'order.fulfilled' ||
    event.aggregateId !== order.id ||
    event.organizationId !== order.organizationId ||
    event.payload.orderId !== order.id ||
    event.payload.eventId !== order.eventId ||
    JSON.stringify(event.payload.receiptFacts) !== JSON.stringify(receipt)
  )
    throw new ConflictError('Fulfillment receipt intent does not match its paid order');
  if (order.fulfillmentState === 'complete') return order;
  return {
    ...bumpVersion(order, input.now),
    fulfillmentState: 'complete',
    fulfillmentCompletedAt: input.now.toISOString(),
    receiptFacts: receipt,
  };
}
