import { describe, expect, it } from 'vitest';

import { selectRefundTargets } from './models/refund-targets.js';

const tickets = [
  { id: 'aayush', tierId: 'general', status: 'valid' },
  { id: 'riya', tierId: 'general', status: 'valid' },
] as const;
describe('attendee-specific refund targeting', () => {
  it('targets Riya without choosing a different attendee by sort order', () => {
    expect(selectRefundTargets(tickets, { targetEntitlementIds: ['riya'] })).toEqual({
      targetEntitlementIds: ['riya'],
      ticketLines: [{ tierId: 'general', quantity: 1 }],
    });
  });
  it.each([{ ids: ['stranger'] }, { ids: ['riya', 'riya'] }])(
    'rejects invalid or duplicate ticket identities $ids',
    ({ ids }) => {
      expect(() => selectRefundTargets(tickets, { targetEntitlementIds: ids })).toThrow();
    },
  );
  it('rejects ambiguous legacy partial quantities but permits selecting the entire tier', () => {
    expect(() =>
      selectRefundTargets(tickets, { ticketLines: [{ tierId: 'general', quantity: 1 }] }),
    ).toThrow('specific ticket');
    expect(
      selectRefundTargets(tickets, { ticketLines: [{ tierId: 'general', quantity: 2 }] })
        .targetEntitlementIds,
    ).toEqual(['aayush', 'riya']);
  });
  it('rejects mismatched explicit identities and tier quantities', () => {
    expect(() =>
      selectRefundTargets(tickets, {
        targetEntitlementIds: ['riya'],
        ticketLines: [{ tierId: 'other', quantity: 1 }],
      }),
    ).toThrow();
  });
  it('does not target already voided tickets', () => {
    expect(() =>
      selectRefundTargets([{ ...tickets[1], status: 'void' }], { targetEntitlementIds: ['riya'] }),
    ).toThrow();
  });
});
