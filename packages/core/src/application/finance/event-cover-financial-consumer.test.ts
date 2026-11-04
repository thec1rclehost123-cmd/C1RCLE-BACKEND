import { describe, expect, it } from 'vitest';

import { domainEvent } from '../../domain/events.js';
import { createEventCoverAccount } from '../../domain/models/event-cover.js';
import {
  createPostedJournal,
  DEFAULT_ACCOUNTING_POLICY,
  deterministicFinancialId,
} from '../../domain/models/financial-journal.js';
import { MemoryEventCoverAccountRepository } from '../../infrastructure/memory/memory-event-cover-account-repository.js';
import { MemoryFinancialJournalRepository } from '../../infrastructure/memory/memory-financial-journal-repository.js';

import { createEventCoverFinancialConsumer } from './event-cover-financial-consumer.js';

describe('event cover financial outbox consumer', () => {
  it('posts redeemed value into a payout-excluded hold and reverses it idempotently', async () => {
    const eventCoverAccounts = new MemoryEventCoverAccountRepository();
    const financialJournals = new MemoryFinancialJournalRepository();
    const account = createEventCoverAccount({
      entitlementId: 'ENT-cover-finance-1',
      orderId: 'ORD-cover-finance-1',
      eventId: 'EVT-cover-finance-1',
      guestUserId: 'USR-cover-finance-1',
      hostOrganizationId: 'ORG-host-finance-1',
      venueOrganizationId: 'ORG-venue-finance-1',
      amountPaise: 50_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'cover-policy-v1',
      refundPolicy: 'saved_policy_review',
      activationApproved: true,
    });
    await eventCoverAccounts.createIssuedAccount(account);
    const operationId = 'POS-cover-finance-1';
    await eventCoverAccounts.reserve(account.id, {
      amountPaise: 12_000,
      operationId,
      guestConfirmed: true,
      online: true,
      actorUserId: 'USR-cover-finance-operator',
      terminalId: 'TERM-cover-finance-1',
      receiptReference: 'POS-RECEIPT-cover-finance-1',
    });
    await eventCoverAccounts.capture(account.id, operationId);
    await financialJournals.postBatch([
      createPostedJournal({
        organizationId: account.hostOrganizationId,
        currency: 'INR',
        source: {
          type: 'online_payment_capture',
          id: account.orderId,
          orderId: account.orderId,
          paymentId: 'pay_cover_finance_1',
          eventId: account.eventId,
        },
        idempotencyKey: 'fixture:cover-sale:collection',
        accountingPolicy: DEFAULT_ACCOUNTING_POLICY,
        components: null,
        lines: [
          {
            account: 'provider_clearing',
            side: 'debit',
            amountPaise: account.issuedPaise,
            organizationId: account.hostOrganizationId,
            component: null,
            memo: 'Fixture cover collection',
          },
          {
            account: 'event_cover_liability',
            side: 'credit',
            amountPaise: account.issuedPaise,
            organizationId: account.hostOrganizationId,
            component: 'eventCoverLiabilityPaise',
            memo: 'Fixture cover liability',
          },
        ],
      }),
    ]);
    const consume = createEventCoverFinancialConsumer({ eventCoverAccounts, financialJournals });
    const redemptionId = deterministicFinancialId('ECR', `${account.id}:${operationId}`);
    const now = new Date('2026-10-28T12:00:00.000Z');
    const common = {
      aggregateId: account.id,
      organizationId: account.hostOrganizationId,
      actorId: 'USR-cover-finance-operator',
      occurredAt: now.getTime(),
    };
    const redemption = domainEvent({
      ...common,
      id: 'evt-cover-redeemed-1',
      type: 'event-cover.redeemed',
      payload: {
        accountId: account.id,
        entitlementId: account.entitlementId,
        eventId: account.eventId,
        operationId,
        venueOrganizationId: account.venueOrganizationId,
        amountPaise: 12_000,
      },
    });
    await consume(redemption);
    await consume(redemption);
    const [posted] = await financialJournals.findBySource('event_cover_redemption', redemptionId);
    expect(posted?.lines).toMatchObject([
      { account: 'event_cover_liability', side: 'debit', amountPaise: 12_000 },
      {
        account: 'event_cover_venue_payable_held',
        side: 'credit',
        amountPaise: 12_000,
        organizationId: account.venueOrganizationId,
      },
    ]);
    await expect(
      financialJournals.sumPayableByOrganization(account.venueOrganizationId),
    ).resolves.toBe(0);

    const reversed = domainEvent({
      ...common,
      id: 'evt-cover-reversed-1',
      type: 'event-cover.reversed',
      payload: redemption.payload,
    });
    await eventCoverAccounts.reverseCapture(
      account.entitlementId,
      operationId,
      'FIN-cover-reviewer',
      'Venue confirmed the wrong amount',
    );
    await consume(reversed);
    await consume(reversed);
    const reversals = await financialJournals.findBySource(
      'event_cover_redemption_reversal',
      redemptionId,
    );
    expect(reversals).toHaveLength(1);
    expect(reversals[0]?.lines).toMatchObject([
      { account: 'event_cover_liability', side: 'credit', amountPaise: 12_000 },
      { account: 'event_cover_venue_payable_held', side: 'debit', amountPaise: 12_000 },
    ]);
  });
});
