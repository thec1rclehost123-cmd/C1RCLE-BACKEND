import { describe, expect, it } from 'vitest';

import { issueEntitlements } from './entitlement.js';
import { createTicketTier } from './event-catalog.js';
import { createOrder } from './order.js';
import { calculatePricing } from './pricing.js';
import { quoteOriginalRefund } from './purchase-refund-snapshot.js';

function purchase(group = false) {
  const tier = createTicketTier({
    id: 'snapshot-tier',
    eventId: 'snapshot-event',
    organizationId: 'snapshot-host',
    name: 'Original admission',
    priceInPaise: 10001,
    quantity: 30,
    ...(group ? { guestCount: 3, admissionMode: 'per_person' as const } : {}),
  });
  const pricing = calculatePricing({ lines: [{ tier, quantity: group ? 1 : 3 }] });
  const order = createOrder({
    id: 'snapshot-order',
    eventId: tier.eventId,
    organizationId: tier.organizationId,
    userId: 'snapshot-buyer',
    contact: { name: 'Synthetic buyer', email: '', phone: '' },
    pricing: {
      ...pricing,
      lines: pricing.lines.map((line) => ({
        ...line,
        ...(group ? { guestCount: 3, admissionMode: 'per_person' as const } : {}),
      })),
    },
  });
  return { order, tickets: issueEntitlements({ order: { ...order, status: 'paid' } }) };
}

describe('original purchase refund components', () => {
  it('refunds only selected original admission for an ordinary eligible Guest refund', () => {
    const { order, tickets } = purchase();
    const selected = tickets[1];
    if (!selected) throw new Error('Missing ticket fixture');
    expect(quoteOriginalRefund(order, [selected.id], 'guest_request')).toMatchObject({
      amountPaise: 10001,
      components: {
        admissionPaise: 10001,
        platformFeePaise: 0,
        paymentFeePaise: 0,
        feeTaxPaise: 0,
      },
    });
  });

  it.each(['organizer_cancel', 'material_change'] as const)(
    'returns full affected original paid components for %s, conserving every paise',
    (cause) => {
      const { order, tickets } = purchase();
      const individual = tickets.map((ticket) => quoteOriginalRefund(order, [ticket.id], cause));
      expect(individual.reduce((sum, quote) => sum + quote.amountPaise, 0)).toBe(
        order.grandTotalPaise,
      );
      expect(
        quoteOriginalRefund(
          order,
          tickets.map((ticket) => ticket.id),
          cause,
        ),
      ).toMatchObject({
        amountPaise: order.grandTotalPaise,
        components: {
          admissionPaise: order.discountedAdmissionSubtotalPaise,
          platformFeePaise: order.platformFeePaise,
          paymentFeePaise: order.paymentFeePaise,
          feeTaxPaise: order.gstPaise,
        },
      });
    },
  );

  it('allocates a per-person group purchase to its independent original admissions', () => {
    const { order, tickets } = purchase(true);
    expect(tickets).toHaveLength(3);
    const amounts = tickets.map(
      (ticket) => quoteOriginalRefund(order, [ticket.id], 'guest_request').amountPaise,
    );
    expect(amounts).toEqual([3334, 3334, 3333]);
    expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(10001);
  });

  it('rejects duplicate or foreign identities rather than guessing which attendee to refund', () => {
    const { order, tickets } = purchase();
    const selected = tickets[0];
    if (!selected) throw new Error('Missing ticket fixture');
    expect(() => quoteOriginalRefund(order, [selected.id, selected.id], 'guest_request')).toThrow();
    expect(() => quoteOriginalRefund(order, ['foreign-ticket'], 'guest_request')).toThrow();
  });

  it('uses the saved purchase snapshot after current order pricing fields are changed', () => {
    const { order, tickets } = purchase();
    const selected = tickets[0];
    if (!selected) throw new Error('Missing ticket fixture');
    const original = quoteOriginalRefund(order, [selected.id], 'material_change');
    expect(
      quoteOriginalRefund(
        { ...order, platformFeePaise: 999999, paymentFeePaise: 999999, gstPaise: 999999 },
        [selected.id],
        'material_change',
      ),
    ).toEqual(original);
  });
});
