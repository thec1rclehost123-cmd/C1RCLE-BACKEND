import { describe, expect, it } from 'vitest';

import {
  IdempotencyConflictError,
  InvalidOperationError,
  NotFoundError,
} from '../../domain/errors.js';
import { journalTotals } from '../../domain/models/financial-journal.js';
import { MemoryFinancialJournalRepository } from '../../infrastructure/memory/memory-financial-journal-repository.js';

import { buildTicketSaleJournals, FinancialPostingService } from './financial-posting-service.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');

function saleInput() {
  return {
    organizationId: 'org_host',
    orderId: 'order_1',
    eventId: 'event_1',
    paymentId: 'pay_1',
    sourceType: 'online_payment_capture' as const,
    providerConfirmed: true,
    currency: 'INR',
    ticketFaceValuePaise: 100_000,
    discountPaise: 10_000,
    discountFundingOwner: 'platform' as const,
    netTicketRevenuePaise: 90_000,
    gstPaise: 16_200,
    platformFeePaise: 9_000,
    paymentFeePaise: 2_000,
    providerFeePaise: 2_500,
    allocation: {
      platformPaise: 0,
      hostOrganizationId: 'org_host',
      hostPaise: 70_000,
      venueOrganizationId: 'org_venue',
      venuePaise: 15_000,
      promoterOrganizationId: 'org_promoter',
      promoterPaise: 5_000,
    },
    postedAt: NOW,
  };
}

describe('FinancialPostingService', () => {
  it('posts balanced collection, net-ticket allocation, and provider-fee journals', async () => {
    const repository = new MemoryFinancialJournalRepository();
    const posted = await new FinancialPostingService(repository).postTicketSale(saleInput());

    expect(posted).toHaveLength(3);
    expect(
      posted.every(
        (journal) => journalTotals(journal).debitPaise === journalTotals(journal).creditPaise,
      ),
    ).toBe(true);
    expect(posted[0]?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: 'provider_clearing',
          side: 'debit',
          amountPaise: 117_200,
        }),
        expect.objectContaining({
          account: 'ticket_collection_control',
          side: 'credit',
          amountPaise: 90_000,
        }),
        expect.objectContaining({
          account: 'gst_tax_liability',
          side: 'credit',
          amountPaise: 16_200,
        }),
      ]),
    );
    expect(posted[1]?.lines.find((line) => line.account === 'host_payable')?.amountPaise).toBe(
      70_000,
    );
    expect(posted[2]?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: 'provider_fee_expense',
          side: 'debit',
          amountPaise: 2_500,
        }),
      ]),
    );
  });

  it('returns exactly the original journals for an exact retry', async () => {
    const repository = new MemoryFinancialJournalRepository();
    const service = new FinancialPostingService(repository);

    const first = await service.postTicketSale(saleInput());
    const replay = await service.postTicketSale(saleInput());

    expect(replay).toEqual(first);
    expect(repository.journals.size).toBe(3);
  });

  it('posts event cover to a separate liability without increasing distributable ticket revenue', async () => {
    const journals = buildTicketSaleJournals({
      ...saleInput(),
      eventCoverLiabilityPaise: 5_000,
    });
    const collection = journals[0];
    expect(collection?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: 'event_cover_liability',
          side: 'credit',
          amountPaise: 5_000,
        }),
        expect.objectContaining({
          account: 'provider_clearing',
          side: 'debit',
          amountPaise: 122_200,
        }),
      ]),
    );
    expect(collection?.components).toMatchObject({
      ticketFaceValuePaise: 100_000,
      eventCoverLiabilityPaise: 5_000,
      netTicketRevenuePaise: 90_000,
    });
    expect(journals[1]?.lines.find((entry) => entry.account === 'host_payable')?.amountPaise).toBe(
      70_000,
    );
  });

  it('rejects reuse of an idempotency key for changed financial content', async () => {
    const repository = new MemoryFinancialJournalRepository();
    const first = buildTicketSaleJournals(saleInput())[0];
    if (!first) throw new Error('ticket sale fixture requires a collection journal');
    await repository.postBatch([first]);

    const changed = {
      ...first,
      lines: first.lines.map((line, index) =>
        index < 2 ? { ...line, amountPaise: line.amountPaise + 1 } : line,
      ),
    };
    await expect(repository.postBatch([changed])).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('requires funding attribution for discounts and provider proof for electronic sales', () => {
    expect(() => buildTicketSaleJournals({ ...saleInput(), discountFundingOwner: null })).toThrow(
      InvalidOperationError,
    );
    expect(() => buildTicketSaleJournals({ ...saleInput(), providerConfirmed: false })).toThrow(
      InvalidOperationError,
    );
    expect(() =>
      buildTicketSaleJournals({
        ...saleInput(),
        sourceType: 'door_electronic_sale',
        paymentId: null,
      }),
    ).toThrow(InvalidOperationError);
  });

  it('records free-ticket evidence without inventing money', async () => {
    const repository = new MemoryFinancialJournalRepository();
    const [evidence] = await new FinancialPostingService(repository).postZeroValueEvidence({
      organizationId: 'org_host',
      orderId: 'order_free',
      eventId: 'event_1',
      currency: 'INR',
      sourceType: 'free_ticket',
      postedAt: NOW,
    });

    expect(evidence).toMatchObject({ evidenceOnly: true, status: 'posted' });
    if (!evidence) throw new Error('free ticket fixture requires an evidence journal');
    expect(journalTotals(evidence)).toEqual({ debitPaise: 0, creditPaise: 0 });
  });

  it('creates one linked reversal and reports a missing original', async () => {
    const repository = new MemoryFinancialJournalRepository();
    const service = new FinancialPostingService(repository);
    const [original] = await service.postTicketSale({ ...saleInput(), providerFeePaise: 0 });
    if (!original) throw new Error('ticket sale fixture requires a collection journal');
    const reversalInput = {
      journalId: original.id,
      source: {
        type: 'refund' as const,
        id: 'refund_1',
        orderId: 'order_1',
        paymentId: 'pay_1',
        eventId: 'event_1',
      },
      idempotencyKey: 'refund:refund_1:collection',
      postedAt: NOW,
    };

    const reversal = await service.reverseJournal(reversalInput);
    expect(reversal.reversalOfJournalId).toBe(original.id);
    expect(await service.reverseJournal(reversalInput)).toEqual(reversal);
    await expect(
      service.reverseJournal({ ...reversalInput, journalId: 'missing' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('allocates repeated partial refunds cumulatively without over-reversing one payable', async () => {
    const repository = new MemoryFinancialJournalRepository();
    const service = new FinancialPostingService(repository);
    await service.postTicketSale({
      ...saleInput(),
      ticketFaceValuePaise: 8,
      discountPaise: 0,
      discountFundingOwner: null,
      netTicketRevenuePaise: 8,
      gstPaise: 0,
      platformFeePaise: 0,
      paymentFeePaise: 0,
      providerFeePaise: 0,
      allocation: {
        platformPaise: 1,
        hostOrganizationId: 'org_host',
        hostPaise: 3,
        venueOrganizationId: 'org_venue',
        venuePaise: 3,
        promoterOrganizationId: 'org_promoter',
        promoterPaise: 1,
      },
    });

    const common = {
      organizationId: 'org_host',
      orderId: 'order_1',
      eventId: 'event_1',
      paymentId: 'pay_1',
      postedAt: NOW,
    };
    const posted = [];
    let previouslyRefundedPaise = 0;
    for (const [index, amountPaise] of [1, 2, 1, 4].entries()) {
      posted.push(
        ...(await service.postRefund({
          ...common,
          refundRequestId: `refund_${String(index + 1)}`,
          providerRefundId: `provider_refund_${String(index + 1)}`,
          amountPaise,
          previouslyRefundedPaise,
        })),
      );
      previouslyRefundedPaise += amountPaise;
    }
    const reversedAmounts = posted
      .filter((journal) => journal.idempotencyKey.endsWith(':payable-reversal'))
      .flatMap((journal) => journal.lines)
      .filter((entry) => entry.side === 'debit')
      .reduce<Record<string, number>>((totals, entry) => {
        totals[entry.account] = (totals[entry.account] ?? 0) + entry.amountPaise;
        return totals;
      }, {});

    expect(reversedAmounts).toEqual({
      platform_commission_revenue: 1,
      host_payable: 3,
      venue_payable: 3,
      promoter_payable: 1,
    });
  });

  it('holds, loses, and releases chargebacks with balanced idempotent journals', async () => {
    const repository = new MemoryFinancialJournalRepository();
    const service = new FinancialPostingService(repository);
    await service.postTicketSale({ ...saleInput(), providerFeePaise: 0 });
    const input = {
      organizationId: 'org_host',
      orderId: 'order_1',
      eventId: 'event_1',
      paymentId: 'pay_1',
      disputeId: 'disp_1',
      amountPaise: 30_000,
      postedAt: NOW,
    };

    const [hold] = await service.postChargebackHold(input);
    const [loss] = await service.settleChargebackLoss(input);
    expect(await service.postChargebackHold(input)).toEqual([hold]);
    expect(await service.settleChargebackLoss(input)).toEqual([loss]);
    for (const journal of [hold, loss]) {
      if (!journal) throw new Error('chargeback fixture requires journals');
      expect(journalTotals(journal).debitPaise).toBe(journalTotals(journal).creditPaise);
    }
    expect(hold?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: 'chargeback_reserve',
          side: 'credit',
          amountPaise: 30_000,
        }),
      ]),
    );

    const releaseInput = { ...input, disputeId: 'disp_2' };
    const [secondHold] = await service.postChargebackHold(releaseInput);
    const [release] = await service.releaseChargebackHold(releaseInput);
    expect(release?.reversalOfJournalId).toBe(secondHold?.id);
    if (!release) throw new Error('chargeback release fixture requires a journal');
    expect(journalTotals(release).debitPaise).toBe(journalTotals(release).creditPaise);
  });
});
