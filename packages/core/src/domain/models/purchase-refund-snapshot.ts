import { InvalidOperationError } from '../errors.js';

import { entitlementId } from './entitlement.js';

import type { Order } from './order.js';

export type RefundCause =
  'guest_request' | 'organizer_cancel' | 'material_change' | 'fulfillment_failure';
export interface RefundComponents {
  admissionPaise: number;
  platformFeePaise: number;
  paymentFeePaise: number;
  feeTaxPaise: number;
  otherPaidPaise: number;
}
export interface OriginalPurchaseRefundSnapshot {
  readonly version: 'm4-original-paid-v1';
  readonly policyVersion: string;
  readonly currency: string;
  readonly tickets: readonly (Readonly<RefundComponents> & {
    readonly entitlementId: string;
    readonly totalPaidPaise: number;
  })[];
}

/** Largest remainders, with ties in immutable original ticket order. */
function allocate(total: number, weights: readonly number[]): number[] {
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    weights.some((weight) => !Number.isSafeInteger(weight) || weight < 0)
  )
    throw new InvalidOperationError('Invalid original purchase components');
  const sum = weights.reduce((amount, weight) => amount + BigInt(weight), 0n);
  if (sum === 0n) {
    if (total !== 0) throw new InvalidOperationError('Paid components have no original allocation');
    return weights.map(() => 0);
  }
  const shares = weights.map((weight, index) => {
    const numerator = BigInt(total) * BigInt(weight);
    return { index, amount: Number(numerator / sum), remainder: numerator % sum };
  });
  let remaining = total - shares.reduce((amount, share) => amount + share.amount, 0);
  const ranked = [...shares].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const share of ranked) {
    if (remaining === 0) break;
    share.amount += 1;
    remaining -= 1;
  }
  if (remaining !== 0) throw new InvalidOperationError('Original allocation did not reconcile');
  return shares.map((share) => share.amount);
}

function total(components: RefundComponents): number {
  const amount =
    components.admissionPaise +
    components.platformFeePaise +
    components.paymentFeePaise +
    components.feeTaxPaise +
    components.otherPaidPaise;
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new InvalidOperationError('Refund components exceed supported monetary range');
  return amount;
}

/** Captured once at purchase creation, never from current catalog/config. */
export function snapshotOriginalPurchase(order: Order): OriginalPurchaseRefundSnapshot {
  if (!order.feePolicy) throw new InvalidOperationError('Original fee policy is required');
  // Snapshot planned deterministic units without issuing admission rights.
  const issued = order.lines.flatMap((line) => {
    const count =
      line.quantity * (line.admissionMode === 'per_person' ? (line.guestCount ?? 1) : 1);
    if (!Number.isSafeInteger(count) || count < 1)
      throw new InvalidOperationError('Invalid original admission count');
    return Array.from({ length: count }, (_, index) => ({
      id: entitlementId(order.id, line.tierId, index),
      tierId: line.tierId,
    }));
  });
  const admissionTotal = order.discountedAdmissionSubtotalPaise ?? order.discountedSubtotalPaise;
  const admissionByLine = allocate(
    admissionTotal,
    order.lines.map(
      (line) =>
        line.discountedAdmissionSubtotalPaise ?? line.admissionSubtotalPaise ?? line.subtotalPaise,
    ),
  );
  const otherWeights = order.lines.map(
    (line) => (line.coverSubtotalPaise ?? 0) + (line.addOnSubtotalPaise ?? 0),
  );
  const otherByLine = allocate(
    order.discountedSubtotalPaise - admissionTotal,
    otherWeights.some((weight) => weight > 0) ? otherWeights : admissionByLine,
  );
  const units: { entitlementId: string; admissionPaise: number; otherPaidPaise: number }[] = [];
  for (const [index, line] of order.lines.entries()) {
    const tickets = issued.filter((ticket) => ticket.tierId === line.tierId);
    const admission = allocate(
      admissionByLine[index] ?? 0,
      tickets.map(() => 1),
    );
    const other = allocate(
      otherByLine[index] ?? 0,
      tickets.map(() => 1),
    );
    for (const [unitIndex, ticket] of tickets.entries())
      units.push({
        entitlementId: ticket.id,
        admissionPaise: admission[unitIndex] ?? 0,
        otherPaidPaise: other[unitIndex] ?? 0,
      });
  }
  const weights = units.map((unit) => unit.admissionPaise + unit.otherPaidPaise);
  const platform = allocate(order.platformFeePaise, weights);
  const payment = allocate(order.paymentFeePaise, weights);
  const tax = allocate(order.gstPaise, weights);
  const tickets = units.map((unit, index) => {
    const components = {
      ...unit,
      platformFeePaise: platform[index] ?? 0,
      paymentFeePaise: payment[index] ?? 0,
      feeTaxPaise: tax[index] ?? 0,
    };
    return Object.freeze({ ...components, totalPaidPaise: total(components) });
  });
  if (
    tickets.reduce((amount, ticket) => amount + ticket.totalPaidPaise, 0) !== order.grandTotalPaise
  )
    throw new InvalidOperationError('Original ticket components do not match the purchase total');
  return Object.freeze({
    version: 'm4-original-paid-v1',
    policyVersion: order.feePolicy.version,
    currency: order.currency,
    tickets: Object.freeze(tickets),
  });
}

export function quoteOriginalRefund(
  order: Order,
  ids: readonly string[],
  cause: RefundCause,
): {
  amountPaise: number;
  components: RefundComponents;
  purchasePolicyVersion: string;
  cause: RefundCause;
} {
  const snapshot = order.refundSnapshot;
  if (
    !snapshot ||
    snapshot.currency !== order.currency ||
    ids.length === 0 ||
    new Set(ids).size !== ids.length ||
    !['guest_request', 'organizer_cancel', 'material_change', 'fulfillment_failure'].includes(cause)
  )
    throw new InvalidOperationError(
      'A valid original purchase and exact ticket selection are required',
    );
  const components: RefundComponents = {
    admissionPaise: 0,
    platformFeePaise: 0,
    paymentFeePaise: 0,
    feeTaxPaise: 0,
    otherPaidPaise: 0,
  };
  for (const id of ids) {
    const ticket = snapshot.tickets.find((item) => item.entitlementId === id);
    if (!ticket) throw new InvalidOperationError('Ticket is not part of the original purchase');
    components.admissionPaise += ticket.admissionPaise;
    if (cause !== 'guest_request') {
      components.platformFeePaise += ticket.platformFeePaise;
      components.paymentFeePaise += ticket.paymentFeePaise;
      components.feeTaxPaise += ticket.feeTaxPaise;
      components.otherPaidPaise += ticket.otherPaidPaise;
    }
  }
  return {
    amountPaise: total(components),
    components,
    purchasePolicyVersion: snapshot.policyVersion,
    cause,
  };
}
