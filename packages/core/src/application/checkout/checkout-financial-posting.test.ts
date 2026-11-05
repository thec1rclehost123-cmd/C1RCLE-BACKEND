import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { journalTotals } from '../../domain/models/financial-journal.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { buildRepositories } from '../../infrastructure/utils.js';

import { CheckoutService } from './checkout-service.js';

import type { Order } from '../../domain/models/order.js';
import type { ServiceDeps } from '../context.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');

describe('CheckoutService canonical financial posting', () => {
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
