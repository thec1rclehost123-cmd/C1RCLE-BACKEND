import { InvalidOperationError } from '../../domain/errors.js';
import {
  createPostedJournal,
  createReversalJournal,
  deterministicFinancialId,
} from '../../domain/models/financial-journal.js';

import type { DomainEvent } from '../../domain/events.js';
import type {
  EventCoverAccountRepository,
  FinancialJournalRepository,
} from '../../domain/ports/repositories.js';

export interface EventCoverFinancialConsumerDeps {
  readonly eventCoverAccounts: EventCoverAccountRepository;
  readonly financialJournals: FinancialJournalRepository;
}

/** Posts confirmed redemption and reversal facts idempotently from the durable outbox. */
export function createEventCoverFinancialConsumer(deps: EventCoverFinancialConsumerDeps) {
  return async function postEventCoverFinancialFacts(event: DomainEvent): Promise<void> {
    if (event.type !== 'event-cover.redeemed' && event.type !== 'event-cover.reversed') return;
    const payload = event.payload;
    const accountId = payload.accountId;
    const entitlementId = payload.entitlementId;
    const eventId = payload.eventId;
    const operationId = payload.operationId;
    const venueOrganizationId = payload.venueOrganizationId;
    const amountPaise = payload.amountPaise;
    if (
      typeof accountId !== 'string' ||
      typeof entitlementId !== 'string' ||
      typeof eventId !== 'string' ||
      typeof operationId !== 'string' ||
      typeof venueOrganizationId !== 'string' ||
      !Number.isSafeInteger(amountPaise) ||
      (amountPaise as number) <= 0
    ) {
      throw new InvalidOperationError('Cover financial event payload is malformed');
    }
    const amount = amountPaise as number;
    const account = await deps.eventCoverAccounts.getByEntitlement(entitlementId);
    if (
      !account ||
      account.id !== accountId ||
      account.eventId !== eventId ||
      account.venueOrganizationId !== venueOrganizationId
    ) {
      throw new InvalidOperationError('Cover financial event does not match its account');
    }

    const entries = await deps.eventCoverAccounts.listEntries(account.id);
    const capture = entries.find(
      (entry) =>
        entry.type === 'capture' &&
        entry.operationId === operationId &&
        entry.amountPaise === amount,
    );
    if (!capture) {
      throw new InvalidOperationError(
        'Cover financial event has no matching captured ledger entry',
      );
    }
    if (
      event.type === 'event-cover.reversed' &&
      !entries.some(
        (entry) =>
          entry.type === 'reversal' &&
          entry.operationId === operationId &&
          entry.amountPaise === amount &&
          entry.reversesEntryId === capture.id,
      )
    ) {
      throw new InvalidOperationError('Cover reversal event has no matching ledger reversal');
    }

    const redemptionId = deterministicFinancialId('ECR', `${account.id}:${operationId}`);
    if (event.type === 'event-cover.redeemed') {
      const prior = await deps.financialJournals.findBySource(
        'event_cover_redemption',
        redemptionId,
      );
      if (prior.length > 0) {
        if (
          prior.length !== 1 ||
          prior[0]?.lines.reduce(
            (sum, line) =>
              sum + (line.account === 'event_cover_venue_payable_held' ? line.amountPaise : 0),
            0,
          ) !== amount
        ) {
          throw new InvalidOperationError(
            'Cover redemption journal conflicts with its source event',
          );
        }
        return;
      }

      const saleJournals = await deps.financialJournals.findByOrderId(account.orderId);
      const collection = saleJournals.find(
        (journal) =>
          journal.source.type === 'online_payment_capture' &&
          journal.lines.some(
            (line) =>
              line.account === 'event_cover_liability' &&
              line.organizationId === account.hostOrganizationId &&
              line.amountPaise >= amount,
          ),
      );
      if (!collection || collection.source.paymentId === null) {
        throw new InvalidOperationError('Cover redemption has no confirmed sale accounting policy');
      }
      const idempotencyKey = `m5:event-cover:${account.id}:${operationId}:redemption`;
      await deps.financialJournals.postBatch([
        createPostedJournal({
          organizationId: account.hostOrganizationId,
          currency: account.currency,
          source: {
            type: 'event_cover_redemption',
            id: redemptionId,
            orderId: account.orderId,
            paymentId: collection.source.paymentId,
            eventId: account.eventId,
          },
          idempotencyKey,
          accountingPolicy: collection.accountingPolicy,
          postedAt: new Date(event.occurredAt),
          lines: [
            {
              account: 'event_cover_liability',
              side: 'debit',
              amountPaise: amount,
              organizationId: account.hostOrganizationId,
              component: 'eventCoverLiabilityPaise',
              memo: 'Release redeemed value from event cover liability',
            },
            {
              account: 'event_cover_venue_payable_held',
              side: 'credit',
              amountPaise: amount,
              organizationId: account.venueOrganizationId,
              component: 'eventCoverLiabilityPaise',
              memo: 'Hold redeemed cover value pending settlement approval',
            },
          ],
        }),
      ]);
      return;
    }

    const [redemption] = await deps.financialJournals.findBySource(
      'event_cover_redemption',
      redemptionId,
    );
    if (!redemption) {
      throw new InvalidOperationError('Cover reversal has no redemption journal to reverse');
    }
    const heldAmount = redemption.lines.reduce(
      (sum, line) =>
        sum + (line.account === 'event_cover_venue_payable_held' ? line.amountPaise : 0),
      0,
    );
    if (heldAmount !== amount) {
      throw new InvalidOperationError('Cover reversal amount differs from its redemption journal');
    }
    const idempotencyKey = `m5:event-cover:${account.id}:${operationId}:reversal`;
    const existing = await deps.financialJournals.findByIdempotencyKey(idempotencyKey);
    if (existing) return;
    await deps.financialJournals.postBatch([
      createReversalJournal({
        original: redemption,
        source: {
          type: 'event_cover_redemption_reversal',
          id: redemptionId,
          orderId: account.orderId,
          paymentId: redemption.source.paymentId,
          eventId: account.eventId,
        },
        idempotencyKey,
        postedAt: new Date(event.occurredAt),
      }),
    ]);
  };
}
