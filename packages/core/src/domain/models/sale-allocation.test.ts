import { describe, expect, it } from 'vitest';

import { createLedgerEntry } from './ledger.js';
import { createOrder } from './order.js';
import { allocationFromLedger, validateSaleAllocation } from './sale-allocation.js';

describe('Original sale allocation evidence', () => {
  const order = createOrder({
    id: 'ORD-original',
    organizationId: 'ORG-host',
    eventId: 'EVT-original',
    userId: 'USR-local',
    contact: { name: 'Synthetic', email: 'synthetic@example.test', phone: '' },
    pricing: {
      currency: 'INR',
      lines: [],
      subtotalPaise: 1000,
      discountedSubtotalPaise: 1000,
      discountPaise: 0,
      platformFeePaise: 0,
      paymentFeePaise: 0,
      gstPaise: 0,
      grandTotalPaise: 1000,
      appliedPromoCode: null,
    },
  });
  const entries = [
    ['ticket_revenue', 1000, 'ORG-host'],
    ['platform_fee', 150, 'ORG-host'],
    ['host_payout', 650, 'ORG-host'],
    ['venue_share', 200, 'ORG-original-venue'],
  ].map(([entryType, amount, organizationId], i) =>
    createLedgerEntry({
      id: `LED-${i}`,
      orderId: order.id,
      eventId: order.eventId,
      entryType: entryType as 'ticket_revenue' | 'platform_fee' | 'host_payout' | 'venue_share',
      amount: amount as number,
      organizationId: organizationId as string,
      status: 'pending',
      idempotencyKey: `original-${i}`,
    }),
  );
  it('reconstructs exact paise and original parties only from complete conserving ledger', () => {
    expect(allocationFromLedger(order, entries)).toMatchObject({
      grossPaise: 1000,
      platformPaise: 150,
      hostPaise: 650,
      venuePaise: 200,
      venueOrganizationId: 'ORG-original-venue',
    });
  });
  it.each(['partial', 'duplicate', 'foreign', 'nonconserving'] as const)(
    'rejects %s legacy evidence',
    (kind) => {
      const changed = entries.map((row) => ({ ...row }));
      const [first, second] = changed;
      if (!first || !second) throw new Error('Missing original ledger fixture');
      if (kind === 'partial') changed.pop();
      if (kind === 'duplicate') changed.push({ ...first });
      if (kind === 'foreign') first.eventId = 'EVT-other';
      if (kind === 'nonconserving') second.amount = 151;
      expect(() => allocationFromLedger(order, changed)).toThrow(/Original sale/);
    },
  );
  it('rejects negative or fractional frozen amounts rather than adjusting the Host remainder', () => {
    const original = allocationFromLedger(order, entries);
    expect(() =>
      validateSaleAllocation({ ...original, hostPaise: -1 }, 1000, order.organizationId),
    ).toThrow();
    expect(() =>
      validateSaleAllocation(
        { ...original, platformPaise: 150.5, hostPaise: 649.5 },
        1000,
        order.organizationId,
      ),
    ).toThrow();
  });
});
