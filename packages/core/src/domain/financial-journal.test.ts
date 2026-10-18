import { describe, expect, it } from 'vitest';

import { InvalidOperationError } from './errors.js';
import {
  createPostedJournal,
  createReversalJournal,
  DEFAULT_ACCOUNTING_POLICY,
  journalTotals,
} from './models/financial-journal.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');

function journal() {
  return createPostedJournal({
    organizationId: 'org_host',
    currency: 'inr',
    source: {
      type: 'online_payment_capture',
      id: 'order_1',
      orderId: 'order_1',
      paymentId: 'pay_1',
      eventId: 'event_1',
    },
    idempotencyKey: 'sale:order_1',
    accountingPolicy: DEFAULT_ACCOUNTING_POLICY,
    postedAt: NOW,
    lines: [
      {
        account: 'provider_clearing',
        side: 'debit',
        amountPaise: 10_000,
        organizationId: 'org_host',
        component: null,
        memo: 'Capture',
      },
      {
        account: 'ticket_collection_control',
        side: 'credit',
        amountPaise: 10_000,
        organizationId: 'org_host',
        component: 'netTicketRevenuePaise',
        memo: 'Ticket value',
      },
    ],
  });
}

describe('financial journal invariants', () => {
  it('normalizes currency, balances, freezes, and derives stable identifiers', () => {
    const first = journal();
    const replay = journal();

    expect(first.currency).toBe('INR');
    expect(journalTotals(first)).toEqual({ debitPaise: 10_000, creditPaise: 10_000 });
    expect(replay.id).toBe(first.id);
    expect(replay.lines.map((line) => line.id)).toEqual(first.lines.map((line) => line.id));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.lines)).toBe(true);
    expect(first.lines.every(Object.isFrozen)).toBe(true);
  });

  it('rejects non-integer paise, invalid currency, unbalanced, and zero-value financial entries', () => {
    const base = journal();
    const [debit, credit] = base.lines;
    if (!debit || !credit) throw new Error('test journal fixture requires two lines');
    const input = {
      organizationId: base.organizationId,
      source: base.source,
      idempotencyKey: 'bad',
      accountingPolicy: base.accountingPolicy,
      postedAt: NOW,
    };

    expect(() =>
      createPostedJournal({
        ...input,
        currency: 'IN',
        lines: base.lines,
      }),
    ).toThrow(InvalidOperationError);
    expect(() =>
      createPostedJournal({
        ...input,
        currency: 'INR',
        lines: [
          { ...debit, amountPaise: 1.5 },
          { ...credit, amountPaise: 1.5 },
        ],
      }),
    ).toThrow(InvalidOperationError);
    expect(() =>
      createPostedJournal({
        ...input,
        currency: 'INR',
        lines: [{ ...debit, amountPaise: 9_999 }, credit],
      }),
    ).toThrow(InvalidOperationError);
    expect(() =>
      createPostedJournal({
        ...input,
        currency: 'INR',
        lines: [
          { ...debit, amountPaise: 0 },
          { ...credit, amountPaise: 0 },
        ],
      }),
    ).toThrow(InvalidOperationError);
  });

  it('creates an immutable, balanced reversal linked to the original journal', () => {
    const original = journal();
    const reversal = createReversalJournal({
      original,
      source: {
        type: 'refund',
        id: 'refund_1',
        orderId: 'order_1',
        paymentId: 'pay_1',
        eventId: 'event_1',
      },
      idempotencyKey: 'refund:refund_1',
      postedAt: NOW,
    });

    expect(reversal.reversalOfJournalId).toBe(original.id);
    expect(reversal.lines[0]?.side).toBe('credit');
    expect(reversal.lines[1]?.side).toBe('debit');
    expect(journalTotals(reversal)).toEqual({ debitPaise: 10_000, creditPaise: 10_000 });
  });
});
