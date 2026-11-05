import {
  applyOrderRefund,
  attachPaymentIntent,
  calculatePricing,
  createOrder,
  createTicketTier,
  lockOrderForRefund,
  markPaid,
} from '@c1rcle/core/domain';
import { describe, expect, it } from 'vitest';

import { orderToDto } from './order-dto.js';

function purchase() {
  const tier = createTicketTier({
    id: 'tier-original',
    eventId: 'event-original',
    organizationId: 'host-original',
    name: 'Admission',
    priceInPaise: 10000,
    quantity: 10,
  });
  const order = createOrder({
    id: 'order-refund-state',
    eventId: tier.eventId,
    organizationId: tier.organizationId,
    userId: 'buyer-original',
    contact: { name: 'Synthetic', email: '', phone: '' },
    pricing: calculatePricing({ lines: [{ tier, quantity: 2 }] }),
  });
  return markPaid(attachPaymentIntent(order, 'order_test_original'), 'pay_test_original');
}
function refund(order: ReturnType<typeof purchase>, indices: number[]) {
  const tickets = order.refundSnapshot?.tickets;
  if (!tickets) throw new Error('Missing original purchase');
  const selected = indices.map((index) => {
    const ticket = tickets[index];
    if (!ticket) throw new Error('Missing original ticket');
    return ticket;
  });
  return applyOrderRefund(
    lockOrderForRefund(order),
    selected.reduce((sum, ticket) => sum + ticket.admissionPaise, 0),
    undefined,
    'refund-original',
    selected.map((ticket) => ({ entitlementId: ticket.entitlementId, tierId: 'tier-original' })),
  );
}
describe('Order admission refund read projection', () => {
  it('reports all admissions refunded even though fees retained keep the financial order paid', () => {
    const order = refund(purchase(), [0, 1]);
    expect(order.status).toBe('paid');
    expect(order.refundedPaise).toBe(20000);
    expect(order.grandTotalPaise).toBeGreaterThan(order.refundedPaise);
    const dto = orderToDto(order);
    expect(dto).toHaveProperty('admissionRefundState', 'all');
    expect(dto.refundedPaise).toBe(order.refundedPaise);
    expect(dto).not.toHaveProperty('refundSnapshot');
    expect(dto).not.toHaveProperty('refundedTicketClaims');
  });
  it('reports partial from exact original identities, not refunded money proportions', () => {
    expect(orderToDto(refund(purchase(), [0]))).toHaveProperty('admissionRefundState', 'partial');
  });
  it('does not count foreign, duplicate, or uncommitted claim identities as additional admissions', () => {
    const order = refund(purchase(), [0]);
    const claim = order.refundedTicketClaims?.[0];
    if (!claim) throw new Error('Missing settled claim');
    expect(
      orderToDto({
        ...order,
        refundedTicketClaims: [
          claim,
          claim,
          { ...claim, entitlementId: 'foreign' },
          {
            ...claim,
            entitlementId: order.refundSnapshot?.tickets[1]?.entitlementId ?? '',
            refundRequestId: 'not-applied',
          },
        ],
      }),
    ).toHaveProperty('admissionRefundState', 'partial');
  });
  it('reports none before settlement and leaves legacy orders without original snapshots unclassified', () => {
    const order = purchase();
    expect(orderToDto(lockOrderForRefund(order))).toHaveProperty('admissionRefundState', 'none');
    const { refundSnapshot: _snapshot, ...legacy } = order;
    expect(orderToDto(legacy)).not.toHaveProperty('admissionRefundState');
  });
});
