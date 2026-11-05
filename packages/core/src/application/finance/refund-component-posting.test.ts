import { describe, expect, it } from 'vitest';

import { journalTotals } from '../../domain/models/financial-journal.js';
import { MemoryFinancialJournalRepository } from '../../infrastructure/memory/memory-financial-journal-repository.js';

import { FinancialPostingService } from './financial-posting-service.js';

async function fixture() {
  const repository = new MemoryFinancialJournalRepository();
  const posting = new FinancialPostingService(repository);
  await posting.postTicketSale({
    organizationId: 'host',
    orderId: 'original-order',
    eventId: 'event',
    paymentId: 'pay_fixture',
    sourceType: 'online_payment_capture',
    providerConfirmed: true,
    currency: 'INR',
    ticketFaceValuePaise: 10000,
    discountPaise: 0,
    discountFundingOwner: null,
    netTicketRevenuePaise: 10000,
    gstPaise: 135,
    platformFeePaise: 500,
    paymentFeePaise: 250,
    providerFeePaise: 0,
    allocation: {
      platformPaise: 1500,
      hostOrganizationId: 'host',
      hostPaise: 8500,
      venueOrganizationId: 'venue',
      venuePaise: 0,
      promoterOrganizationId: null,
      promoterPaise: 0,
    },
  });
  const base = {
    organizationId: 'host',
    orderId: 'original-order',
    eventId: 'event',
    paymentId: 'pay_fixture',
    postedAt: new Date('2026-11-04T00:00:00Z'),
  };
  return { posting, repository, base };
}
const admission = (amount: number) => ({
  admissionPaise: amount,
  platformFeePaise: 0,
  paymentFeePaise: 0,
  feeTaxPaise: 0,
  otherPaidPaise: 0,
});

describe('original component refund posting', () => {
  it('does not debit a payable again after its identified entry was reversed', async () => {
    const { posting, repository, base } = await fixture();
    const sale = await repository.findBySource('online_payment_capture', base.orderId);
    const allocation = sale.find((journal) => journal.idempotencyKey.endsWith(':allocation'));
    if (!allocation) throw new Error('Original allocation missing');
    await posting.reverseJournal({
      journalId: allocation.id,
      source: {
        type: 'partner_dispute_reversal',
        id: 'dispute-correction',
        orderId: base.orderId,
        paymentId: base.paymentId,
        eventId: base.eventId,
      },
      idempotencyKey: 'partner-reversal-test',
      postedAt: base.postedAt,
    });
    const input = {
      ...base,
      refundRequestId: 'refund-after-correction',
      providerRefundId: 'rfnd_after_correction',
      amountPaise: 10000,
      previouslyRefundedPaise: 0,
      refundComponents: admission(10000),
    };
    const result = await posting.postRefund(input);
    expect(result.some((journal) => journal.idempotencyKey.endsWith(':payable-reversal'))).toBe(
      false,
    );
    expect(await repository.sumPayableByOrganization('host')).toBe(0);
    expect(await posting.postRefund(input)).toEqual(result);
  });

  it('caps each fee component across distinct refunds', async () => {
    const { posting, base, repository } = await fixture();
    await posting.postRefund({
      ...base,
      refundRequestId: 'platform-first',
      providerRefundId: 'rfnd_platform_first',
      amountPaise: 400,
      previouslyRefundedPaise: 0,
      refundComponents: { ...admission(0), platformFeePaise: 400 },
    });
    await expect(
      posting.postRefund({
        ...base,
        refundRequestId: 'platform-second',
        providerRefundId: 'rfnd_platform_second',
        amountPaise: 200,
        previouslyRefundedPaise: 400,
        refundComponents: { ...admission(0), platformFeePaise: 200 },
      }),
    ).rejects.toThrow();
    expect(await repository.findBySource('refund', 'platform-second')).toEqual([]);
  });

  it('requires review instead of guessing a prior legacy fee split', async () => {
    const { posting, base, repository } = await fixture();
    await posting.postRefund({
      ...base,
      refundRequestId: 'legacy-first',
      providerRefundId: 'rfnd_legacy_first',
      amountPaise: 1000,
      previouslyRefundedPaise: 0,
    });
    await expect(
      posting.postRefund({
        ...base,
        refundRequestId: 'typed-after-legacy',
        providerRefundId: 'rfnd_typed_after_legacy',
        amountPaise: 1,
        previouslyRefundedPaise: 1000,
        refundComponents: { ...admission(0), paymentFeePaise: 1 },
      }),
    ).rejects.toThrow('financial review');
    expect(await repository.findBySource('refund', 'typed-after-legacy')).toEqual([]);
  });
  it('rejects a platform-only refund above its original component even when combined fees cover it', async () => {
    const { posting, base, repository } = await fixture();
    await expect(
      posting.postRefund({
        ...base,
        refundRequestId: 'excess-platform',
        providerRefundId: 'rfnd_excess_platform',
        amountPaise: 750,
        previouslyRefundedPaise: 0,
        refundComponents: { ...admission(0), platformFeePaise: 750 },
      }),
    ).rejects.toThrow();
    expect(await repository.findBySource('refund', 'excess-platform')).toEqual([]);
  });

  it('rejects a replay that swaps distinct fee components despite an unchanged total', async () => {
    const { posting, base } = await fixture();
    const input = {
      ...base,
      refundRequestId: 'fee-replay',
      providerRefundId: 'rfnd_fee_replay',
      amountPaise: 300,
      previouslyRefundedPaise: 0,
      refundComponents: { ...admission(0), platformFeePaise: 200, paymentFeePaise: 100 },
    };
    await posting.postRefund(input);
    await expect(
      posting.postRefund({
        ...input,
        refundComponents: { ...admission(0), platformFeePaise: 100, paymentFeePaise: 200 },
      }),
    ).rejects.toThrow();
  });

  it('retains disclosed fees/tax on an ordinary Guest admission refund', async () => {
    const { posting, base } = await fixture();
    const posted = await posting.postRefund({
      ...base,
      refundRequestId: 'guest-refund',
      providerRefundId: 'rfnd_guest',
      amountPaise: 10000,
      previouslyRefundedPaise: 0,
      refundComponents: admission(10000),
    });
    const recognition = posted.find((journal) => journal.idempotencyKey.endsWith(':recognition'));
    expect(recognition?.lines.filter((line) => line.side === 'debit')).toEqual([
      expect.objectContaining({ account: 'ticket_collection_control', amountPaise: 10000 }),
    ]);
    expect(
      posted.every(
        (journal) => journalTotals(journal).debitPaise === journalTotals(journal).creditPaise,
      ),
    ).toBe(true);
  });

  it('reverses full original paid components for organizer-caused remedies', async () => {
    const { posting, base } = await fixture();
    const posted = await posting.postRefund({
      ...base,
      refundRequestId: 'organizer-refund',
      providerRefundId: 'rfnd_organizer',
      amountPaise: 10885,
      previouslyRefundedPaise: 0,
      refundComponents: {
        ...admission(10000),
        platformFeePaise: 500,
        paymentFeePaise: 250,
        feeTaxPaise: 135,
      },
    });
    const recognition = posted.find((journal) => journal.idempotencyKey.endsWith(':recognition'));
    expect(recognition?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: 'ticket_collection_control',
          side: 'debit',
          amountPaise: 10000,
        }),
        expect.objectContaining({
          account: 'platform_fee_revenue',
          side: 'debit',
          amountPaise: 750,
        }),
        expect.objectContaining({ account: 'gst_tax_liability', side: 'debit', amountPaise: 135 }),
      ]),
    );
  });

  it('keeps prior Guest fees retained when a different attendee gets a full remedy, and replays the first refund', async () => {
    const { posting, base } = await fixture();
    const firstInput = {
      ...base,
      refundRequestId: 'first-refund',
      providerRefundId: 'rfnd_first',
      amountPaise: 5000,
      previouslyRefundedPaise: 0,
      refundComponents: admission(5000),
    };
    const first = await posting.postRefund(firstInput);
    const second = await posting.postRefund({
      ...base,
      refundRequestId: 'second-refund',
      providerRefundId: 'rfnd_second',
      amountPaise: 5443,
      previouslyRefundedPaise: 5000,
      refundComponents: {
        ...admission(5000),
        platformFeePaise: 250,
        paymentFeePaise: 125,
        feeTaxPaise: 68,
      },
    });
    const recognized = second.find((journal) => journal.idempotencyKey.endsWith(':recognition'));
    expect(recognized?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: 'ticket_collection_control',
          side: 'debit',
          amountPaise: 5000,
        }),
        expect.objectContaining({
          account: 'platform_fee_revenue',
          side: 'debit',
          amountPaise: 375,
        }),
        expect.objectContaining({ account: 'gst_tax_liability', side: 'debit', amountPaise: 68 }),
      ]),
    );
    expect(await posting.postRefund(firstInput)).toEqual(first);
  });

  it('rejects mismatched component totals before posting any refund', async () => {
    const { posting, base, repository } = await fixture();
    await expect(
      posting.postRefund({
        ...base,
        refundRequestId: 'wrong-refund',
        providerRefundId: 'rfnd_wrong',
        amountPaise: 10000,
        previouslyRefundedPaise: 0,
        refundComponents: admission(9999),
      }),
    ).rejects.toThrow();
    expect(await repository.findBySource('refund', 'wrong-refund')).toEqual([]);
  });
});
