import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { createEvent } from '../../domain/models/event.js';
import { journalTotals } from '../../domain/models/financial-journal.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { buildRepositories } from '../../infrastructure/utils.js';
import { buildTicketSaleJournals } from '../finance/financial-posting-service.js';

import { CheckoutService } from './checkout-service.js';

import type { Order } from '../../domain/models/order.js';
import type { ServiceDeps } from '../context.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');

describe('CheckoutService canonical financial posting', () => {
  it('creates no external Venue share or payable for an external-location event', async () => {
    const repositories = buildRepositories({
      STORAGE_DRIVER: 'memory',
      FIRESTORE_PROJECT_ID: 'test-project',
    });
    const event = createEvent({
      id: 'event_external_finance',
      organizationId: 'org_host',
      venueId: null,
      externalLocation: {
        name: 'Independent Hall',
        address: '12 Example Road',
        contact: { managerName: 'Manager', phone: '+91 98765 43210' },
        review: {
          status: 'approved',
          submittedAt: NOW.toISOString(),
          reviewedAt: NOW.toISOString(),
          reviewedBy: 'ops_1',
          rejectionReason: null,
        },
      },
      title: 'External event',
      startAt: '2026-11-15T18:00:00.000Z',
      now: NOW,
    });
    await repositories.events.save(event);
    const service = new CheckoutService({
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'test-project' },
        clock: { now: () => NOW },
      }),
      repositories,
      outbox: new MemoryOutboxStore(),
    } as unknown as ServiceDeps);
    const snapshot = await (
      service as unknown as {
        snapshotSaleAllocation: (
          eventId: string,
          organizationId: string,
          grossPaise: number,
          attribution: null,
        ) => Promise<{
          venueOrganizationId: string;
          venuePaise: number;
          hostOrganizationId: string;
          platformPaise: number;
          hostPaise: number;
          promoterOrganizationId: string | null;
          promoterPaise: number;
        }>;
      }
    ).snapshotSaleAllocation(event.id, 'org_host', 10_000, null);
    expect(snapshot).toMatchObject({
      hostOrganizationId: 'org_host',
      venueOrganizationId: 'org_host',
      venuePaise: 0,
    });
    const journals = buildTicketSaleJournals({
      organizationId: 'org_host',
      orderId: 'order_external',
      eventId: event.id,
      paymentId: 'payment_external',
      sourceType: 'online_payment_capture',
      providerConfirmed: true,
      currency: 'INR',
      ticketFaceValuePaise: 10_000,
      discountPaise: 0,
      discountFundingOwner: null,
      netTicketRevenuePaise: 10_000,
      gstPaise: 0,
      platformFeePaise: snapshot.platformPaise,
      paymentFeePaise: 0,
      allocation: {
        platformPaise: snapshot.platformPaise,
        hostOrganizationId: snapshot.hostOrganizationId,
        hostPaise: snapshot.hostPaise,
        venueOrganizationId: snapshot.venueOrganizationId,
        venuePaise: snapshot.venuePaise,
        promoterOrganizationId: snapshot.promoterOrganizationId,
        promoterPaise: snapshot.promoterPaise,
      },
    });
    const allocationJournal = journals.find((journal) =>
      journal.idempotencyKey.endsWith(':allocation'),
    );
    expect(allocationJournal).toBeDefined();
    expect(allocationJournal?.lines).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ account: 'venue_payable' })]),
    );
  });

  it('allocates discounted ticket revenue while keeping fees and GST separate', async () => {
    const repositories = buildRepositories({
      STORAGE_DRIVER: 'memory',
      FIRESTORE_PROJECT_ID: 'test-project',
    });
    const config = createCoreConfig({
      redis: { url: 'redis://localhost:6379' },
      firestore: { projectId: 'test-project' },
      clock: { now: () => NOW },
    });
    const service = new CheckoutService({
      config,
      repositories,
      outbox: new MemoryOutboxStore(),
    } as unknown as ServiceDeps);
    const order: Order = {
      id: 'order_finance_1',
      eventId: 'event_finance_1',
      organizationId: 'org_host',
      userId: 'user_1',
      contact: { name: 'Test Buyer', email: 'buyer@example.test', phone: '' },
      status: 'paid',
      // Original fixture commercial terms: basic plan (15%), no Venue or Promoter share.
      // Recovery must use these frozen amounts rather than resolve current terms.
      saleAllocation: {
        version: 'sale-allocation-v1',
        grossPaise: 90_000,
        platformPaise: 13_500,
        hostPaise: 76_500,
        venuePaise: 0,
        promoterPaise: 0,
        hostOrganizationId: 'org_host',
        venueOrganizationId: 'org_host',
        promoterOrganizationId: null,
        partnershipId: null,
        partnershipVersion: null,
        onboardingId: null,
        onboardingVersion: null,
        capturedAt: NOW.toISOString(),
      },
      lines: [
        {
          tierId: 'tier_1',
          tierName: 'General',
          quantity: 1,
          unitPricePaise: 100_000,
          subtotalPaise: 100_000,
        },
      ],
      currency: 'INR',
      subtotalPaise: 100_000,
      discountPaise: 10_000,
      discountFundingOwner: 'host',
      discountedSubtotalPaise: 90_000,
      platformFeePaise: 9_000,
      paymentFeePaise: 2_000,
      gstPaise: 1_980,
      grandTotalPaise: 102_980,
      appliedPromoCode: 'HOST10',
      attribution: null,
      paymentIntentId: 'provider_order_1',
      paymentId: 'provider_payment_1',
      paidAt: NOW.toISOString(),
      reservationExpiresAt: NOW.toISOString(),
      failureReason: null,
      refundedPaise: 0,
      appliedRefundRequestIds: [],
      version: 3,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };

    await service.settleOrder(order);
    await service.settleOrder(order);

    const journals = await repositories.financialJournals.findBySource(
      'online_payment_capture',
      order.id,
    );
    expect(journals).toHaveLength(2);
    expect(
      journals.every(
        (journal) => journalTotals(journal).debitPaise === journalTotals(journal).creditPaise,
      ),
    ).toBe(true);
    const collection = journals.find((journal) => journal.idempotencyKey.endsWith(':collection'));
    const allocation = journals.find((journal) => journal.idempotencyKey.endsWith(':allocation'));
    expect(collection?.components).toMatchObject({
      ticketFaceValuePaise: 100_000,
      discountPaise: 10_000,
      discountFundingOwner: 'host',
      netTicketRevenuePaise: 90_000,
      gstPaise: 1_980,
      platformFeePaise: 9_000,
      paymentFeePaise: 2_000,
    });
    expect(
      allocation?.lines
        .filter((line) => line.side === 'credit')
        .reduce((sum, line) => sum + line.amountPaise, 0),
    ).toBe(90_000);

    const legacy = await repositories.ledger.findByOrder(order.id);
    expect(legacy.find((entry) => entry.entryType === 'ticket_revenue')?.amount).toBe(90_000);
    expect(legacy.find((entry) => entry.entryType === 'platform_fee')?.amount).toBe(13_500);
    expect(legacy.find((entry) => entry.entryType === 'host_payout')?.amount).toBe(76_500);
  });
});
