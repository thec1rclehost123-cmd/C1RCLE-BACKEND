import { describe, expect, it, vi } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { ForbiddenError } from '../../domain/errors.js';
import { NON_PRODUCTION_BOOKING_FEE_POLICY } from '../../domain/models/booking-fee-policy.js';
import {
  freezeEntitlementForRefund,
  voidEntitlement,
  issueEntitlements,
} from '../../domain/models/entitlement.js';
import { createPromoCode, createTicketTier } from '../../domain/models/event-catalog.js';
import { createEvent, transitionEvent } from '../../domain/models/event.js';
import {
  applyOrderRefund,
  lockOrderForRefund,
  attachPaymentIntent,
  createOrder,
  markPaid,
} from '../../domain/models/order.js';
import { applyProviderPaymentEvent } from '../../domain/models/provider-payment.js';
import { createTicketAddon } from '../../domain/models/ticket-addon.js';
import { MemoryPaymentProvider } from '../../domain/ports/payment-provider.js';
import { MemoryFinancialJournalRepository } from '../../infrastructure/memory/memory-financial-journal-repository.js';
import { MemoryLeaderboardRepository } from '../../infrastructure/memory/memory-leaderboard-repository.js';
import { MemoryLedgerRepository } from '../../infrastructure/memory/memory-ledger-repository.js';
import { MemoryOnboardingRepository } from '../../infrastructure/memory/memory-onboarding-repository.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { MemoryPartnershipRepository } from '../../infrastructure/memory/memory-partnership-repository.js';
import { MemoryProviderFinancialEventRepository } from '../../infrastructure/memory/memory-provider-financial-event-repository.js';
import { MemoryProviderPaymentRepository } from '../../infrastructure/memory/memory-provider-payment-repository.js';
import { MemoryRefundRequestRepository } from '../../infrastructure/memory/memory-refund-request-repository.js';
import {
  MemoryCartReservationRepository,
  MemoryEntitlementRepository,
  MemoryEventCatalogRepository,
  MemoryEventRepository,
  MemoryOrderRepository,
  MemoryPlatformSettingsRepository,
  MemoryPromoRedemptionRepository,
} from '../../infrastructure/memory/memory-repositories.js';
import { InventoryService } from '../inventory/inventory-service.js';
import { PricingService } from '../pricing/pricing-service.js';
import { TicketService } from '../tickets/ticket-service.js';

import { CheckoutService } from './checkout-service.js';
import { FulfilmentRepairService } from './fulfilment-repair-service.js';

import type { Order } from '../../domain/models/order.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * ─── Payment business-logic audit ────────────────────────────────────────────
 * Each test states a rule the payment path must hold. They were written against
 * the code as found, to prove or disprove suspected defects before fixing them.
 */

const NOW = new Date('2026-10-14T00:00:00.000Z');
const config = createCoreConfig({
  redis: { url: 'redis://localhost:6379' },
  firestore: { projectId: 'test-project' },
  clock: { now: () => NOW },
  features: { m5TicketAddonsEnabled: true },
});
const actor = (userId: string): ActorContext => ({
  userId,
  organizationId: 'org_1',
  role: 'owner',
  capabilities: [],
});

async function build(
  options: {
    eventStatus?: 'published' | 'draft' | 'cancelled';
    config?: ReturnType<typeof createCoreConfig>;
  } = {},
) {
  const events = new MemoryEventRepository();
  const catalog = new MemoryEventCatalogRepository();
  const entitlements = new MemoryEntitlementRepository();
  const refundRequests = new MemoryRefundRequestRepository();
  const orders = new MemoryOrderRepository(undefined, { entitlements, refundRequests, events });
  const carts = new MemoryCartReservationRepository();
  const providerPayments = new MemoryProviderPaymentRepository();
  const providerFinancialEvents = new MemoryProviderFinancialEventRepository();
  const deps = {
    config: options.config ?? config,
    outbox: new MemoryOutboxStore(),
    pricing: new PricingService({ eventCatalog: catalog }),
    inventory: new InventoryService({
      eventCatalog: catalog,
      cartReservation: carts,
      order: orders,
    }),
    repositories: {
      events,
      users: {
        getById: async (id: string) => ({ id, email: `${id}@example.test`, emailVerified: true }),
      },
      catalog,
      cartReservations: carts,
      orders,
      entitlements,
      refundRequests,
      ledger: new MemoryLedgerRepository(),
      financialJournals: new MemoryFinancialJournalRepository(),
      leaderboard: new MemoryLeaderboardRepository(),
      promoRedemptions: new MemoryPromoRedemptionRepository(),
      providerPayments,
      providerFinancialEvents,
      onboarding: new MemoryOnboardingRepository(),
      partnerships: new MemoryPartnershipRepository(),
      platformSettings: new MemoryPlatformSettingsRepository(),
    },
  } as unknown as ServiceDeps;
  orders.fulfilmentStore = {
    carts,
    events,
    entitlements: deps.repositories.entitlements as MemoryEntitlementRepository,
    ledger: deps.repositories.ledger as MemoryLedgerRepository,
    journals: deps.repositories.financialJournals as MemoryFinancialJournalRepository,
    outbox: deps.outbox as MemoryOutboxStore,
    providerPayments: deps.repositories.providerPayments as MemoryProviderPaymentRepository,
  };
  (deps.repositories.entitlements as MemoryEntitlementRepository).issuanceOutbox =
    deps.outbox as MemoryOutboxStore;
  (deps.repositories.entitlements as MemoryEntitlementRepository).admissionOrders = orders;

  let event = createEvent({
    id: 'evt_1',
    organizationId: 'org_1',
    venueId: 'ven_1',
    title: 'Sky Night',
    startAt: '2026-12-01T18:00:00.000Z',
  });
  const path = {
    published: ['review', 'scheduled', 'published'],
    cancelled: ['review', 'scheduled', 'published', 'cancelled'],
    draft: [],
  }[options.eventStatus ?? 'published'] as ('review' | 'scheduled' | 'published' | 'cancelled')[];
  for (const to of path) event = transitionEvent(event, to, NOW);
  await events.save({ ...event, version: 1 });

  return {
    deps,
    catalog,
    orders,
    carts,
    providerPayments,
    providerFinancialEvents,
    events,
    redemptions: deps.repositories.promoRedemptions,
    service: new CheckoutService(deps),
  };
}

async function seedTier(catalog: MemoryEventCatalogRepository, quantity = 10) {
  await catalog.saveTier(
    createTicketTier({
      id: 'tier_1',
      eventId: 'evt_1',
      organizationId: 'org_1',
      name: 'General',
      priceInPaise: 100_000,
      quantity,
      now: NOW,
    }),
  );
}

async function seedAdditionalTier(
  catalog: MemoryEventCatalogRepository,
  id: string,
  guestCount = 1,
  admissionMode: 'bundle' | 'per_person' = 'bundle',
  quantity = 20,
) {
  await catalog.saveTier(
    createTicketTier({
      id,
      eventId: 'evt_1',
      organizationId: 'org_1',
      name: id,
      priceInPaise: 50_000,
      quantity,
      guestCount,
      admissionMode,
      now: NOW,
    }),
  );
}

async function holdFor(
  service: CheckoutService,
  userId: string,
  key: string,
  promoCode: string | null = null,
) {
  const { pricing } = await service.quote({
    actor: actor(userId),
    eventId: 'evt_1',
    lines: [{ tierId: 'tier_1', quantity: 1 }],
    promoCode,
  });
  return service.createHold({
    actor: actor(userId),
    eventId: 'evt_1',
    organizationId: 'org_1',
    lines: pricing.lines.map((l) => ({
      tierId: l.tierId,
      tierName: l.tierName,
      quantity: l.quantity,
      unitPricePaise: l.unitPricePaise,
    })),
    pricing,
    appliedPromoCode: pricing.appliedPromoCode,
    attribution: null,
    idempotencyKey: key,
  });
}

async function holdLinesFor(
  service: CheckoutService,
  userId: string,
  key: string,
  lines: { tierId: string; quantity: number }[],
) {
  const { pricing } = await service.quote({ actor: actor(userId), eventId: 'evt_1', lines });
  return service.createHold({
    actor: actor(userId),
    eventId: 'evt_1',
    organizationId: 'org_1',
    lines: pricing.lines.map((line) => ({
      tierId: line.tierId,
      tierName: line.tierName,
      quantity: line.quantity,
      unitPricePaise: line.unitPricePaise,
    })),
    pricing,
    appliedPromoCode: pricing.appliedPromoCode,
    attribution: null,
    idempotencyKey: key,
  });
}

async function seedPaidSingleTicket(input: Awaited<ReturnType<typeof build>>, userId = 'user_1') {
  const { catalog, service, carts, orders, deps } = input;
  await seedTier(catalog);
  const hold = await holdFor(service, userId, `upgrade-source-${userId}`);
  await carts.bindProviderOrder(hold.id, `pi-source-${userId}`);
  const pending = createOrder({
    id: `order-source-${userId}`,
    eventId: hold.eventId,
    organizationId: hold.organizationId,
    userId,
    contact: { name: 'Guest', email: `${userId}@example.test`, phone: '' },
    pricing: hold.pricing,
    now: NOW,
  });
  const paid = markPaid(
    attachPaymentIntent(pending, `pi-source-${userId}`, NOW),
    `pay-source-${userId}`,
    NOW,
  );
  await orders.save({ ...paid, version: 1 });
  await carts.convertToOrder(hold.id, paid.id);
  const [source] = issueEntitlements({ order: paid, now: NOW });
  if (!source) throw new Error('Expected one source entitlement');
  await deps.repositories.entitlements.save(source);
  return source;
}

describe('bounded checkout ticket upgrades', () => {
  it('quotes and reserves only the authoritative admission-price difference', async () => {
    const state = await build();
    const source = await seedPaidSingleTicket(state);
    await state.catalog.saveTier(
      createTicketTier({
        id: 'tier_premium',
        eventId: 'evt_1',
        organizationId: 'org_1',
        name: 'Premium',
        priceInPaise: 150_000,
        quantity: 4,
        now: NOW,
      }),
    );

    const quote = await state.service.quote({
      actor: actor('user_1'),
      eventId: 'evt_1',
      lines: [{ tierId: 'tier_premium', quantity: 1 }],
      upgradeFromEntitlementId: source.id,
    });
    expect(quote.pricing.subtotalPaise).toBe(50_000);
    expect(quote.pricing.lines[0]).toMatchObject({
      tierId: 'tier_premium',
      admissionUnitPricePaise: 50_000,
      coverUnitPricePaise: 0,
    });
    expect(quote.upgrade).toMatchObject({
      sourceEntitlementId: source.id,
      sourceEntitlementVersion: source.version,
      sourceOrderId: source.orderId,
      targetTierId: 'tier_premium',
      priorAdmissionPaidPaise: 100_000,
      replacementAdmissionPaise: 150_000,
      incrementalAdmissionPaise: 50_000,
    });

    const hold = await state.service.createHold({
      actor: actor('user_1'),
      eventId: 'evt_1',
      organizationId: 'org_1',
      lines: quote.pricing.lines.map((line) => ({
        tierId: line.tierId,
        tierName: line.tierName,
        quantity: line.quantity,
        unitPricePaise: line.unitPricePaise,
        admissionUnitPricePaise: line.admissionUnitPricePaise,
        coverUnitPricePaise: line.coverUnitPricePaise,
      })),
      pricing: quote.pricing,
      appliedPromoCode: null,
      attribution: quote.attribution,
      upgrade: quote.upgrade,
      idempotencyKey: 'premium-upgrade-hold',
    });
    expect(hold.upgrade).toEqual(quote.upgrade);
    expect(hold.lines[0]?.unitPricePaise).toBe(50_000);
    expect(await state.deps.repositories.entitlements.getById(source.id)).toMatchObject({
      status: 'valid',
    });

    state.deps.paymentProvider = {
      createOrder: async (request) => ({
        id: 'pi-upgrade-failed',
        amountPaise: request.amountPaise,
        currency: request.currency,
        status: 'created',
      }),
      getPayment: async (paymentId) => ({
        verified: true,
        paymentId,
        orderId: 'pi-upgrade-failed',
        amountPaise: hold.pricing.grandTotalPaise,
        currency: hold.pricing.currency,
        captured: false,
      }),
      verifyPayment: async () => {
        throw new Error('unused');
      },
      capturePayment: async () => {
        throw new Error('unused');
      },
      getRefund: async () => {
        throw new Error('Refund lookup is not used by this checkout fixture');
      },
      refundPayment: async () => {
        throw new Error('unused');
      },
    };
    const attempt = await state.service.createPaymentIntent({
      actor: actor('user_1'),
      holdId: hold.id,
      idempotencyKey: 'upgrade-failed-payment',
    });
    await expect(
      state.service.confirmPayment({
        actor: actor('user_1'),
        paymentId: 'pay-upgrade-failed',
        paymentIntentId: attempt.paymentIntentId,
        holdId: hold.id,
        _idempotencyKey: 'upgrade-failed-payment-confirmation',
      }),
    ).rejects.toThrow(/has not been captured/);
    expect(await state.deps.repositories.entitlements.getById(source.id)).toMatchObject({
      status: 'valid',
      version: source.version,
    });
  });

  it('rejects a source pass after it is scanned or used by another account', async () => {
    const state = await build();
    const source = await seedPaidSingleTicket(state);
    await state.catalog.saveTier(
      createTicketTier({
        id: 'tier_premium',
        eventId: 'evt_1',
        organizationId: 'org_1',
        name: 'Premium',
        priceInPaise: 150_000,
        quantity: 4,
        now: NOW,
      }),
    );

    const quote = await state.service.quote({
      actor: actor('user_1'),
      eventId: 'evt_1',
      lines: [{ tierId: 'tier_premium', quantity: 1 }],
      upgradeFromEntitlementId: source.id,
    });
    const hold = await state.service.createHold({
      actor: actor('user_1'),
      eventId: 'evt_1',
      organizationId: 'org_1',
      lines: quote.pricing.lines.map((line) => ({
        tierId: line.tierId,
        tierName: line.tierName,
        quantity: line.quantity,
        unitPricePaise: line.unitPricePaise,
        admissionUnitPricePaise: line.admissionUnitPricePaise,
        coverUnitPricePaise: line.coverUnitPricePaise,
      })),
      pricing: quote.pricing,
      appliedPromoCode: null,
      attribution: quote.attribution,
      upgrade: quote.upgrade,
      idempotencyKey: 'upgrade-ticket-later-scanned',
    });

    await expect(
      state.service.quote({
        actor: actor('user_2'),
        eventId: 'evt_1',
        lines: [{ tierId: 'tier_premium', quantity: 1 }],
        upgradeFromEntitlementId: source.id,
      }),
    ).rejects.toThrow(/not eligible/);

    await state.deps.repositories.entitlements.claimAdmission(source.id, source.eventId, {
      now: NOW,
    });
    await expect(
      state.service.quote({
        actor: actor('user_1'),
        eventId: 'evt_1',
        lines: [{ tierId: 'tier_premium', quantity: 1 }],
        upgradeFromEntitlementId: source.id,
      }),
    ).rejects.toThrow(/not eligible/);
    await expect(
      state.service.createPaymentIntent({
        actor: actor('user_1'),
        holdId: hold.id,
        idempotencyKey: 'upgrade-after-source-scan',
      }),
    ).rejects.toThrow(/source ticket changed/);
  });

  it('retires the original pass only after captured payment fulfills the replacement', async () => {
    const state = await build();
    const source = await seedPaidSingleTicket(state);
    const currentEvent = await state.events.getById('evt_1');
    if (!currentEvent) throw new Error('Expected seeded event');
    await state.events.save({ ...currentEvent, venueId: null, version: currentEvent.version + 1 });
    await state.catalog.saveTier(
      createTicketTier({
        id: 'tier_premium',
        eventId: 'evt_1',
        organizationId: 'org_1',
        name: 'Premium',
        priceInPaise: 150_000,
        quantity: 4,
        now: NOW,
      }),
    );
    const quote = await state.service.quote({
      actor: actor('user_1'),
      eventId: 'evt_1',
      lines: [{ tierId: 'tier_premium', quantity: 1 }],
      upgradeFromEntitlementId: source.id,
    });
    const hold = await state.service.createHold({
      actor: actor('user_1'),
      eventId: 'evt_1',
      organizationId: 'org_1',
      lines: quote.pricing.lines.map((line) => ({
        tierId: line.tierId,
        tierName: line.tierName,
        quantity: line.quantity,
        unitPricePaise: line.unitPricePaise,
        admissionUnitPricePaise: line.admissionUnitPricePaise,
        coverUnitPricePaise: line.coverUnitPricePaise,
      })),
      pricing: quote.pricing,
      appliedPromoCode: null,
      attribution: quote.attribution,
      upgrade: quote.upgrade,
      idempotencyKey: 'premium-upgrade-success',
    });
    state.deps.paymentProvider = {
      createOrder: async (request) => ({
        id: 'pi-upgrade-success',
        amountPaise: request.amountPaise,
        currency: request.currency,
        status: 'created',
      }),
      getPayment: async (paymentId) => ({
        verified: true,
        paymentId,
        orderId: 'pi-upgrade-success',
        amountPaise: hold.pricing.grandTotalPaise,
        currency: hold.pricing.currency,
        captured: true,
      }),
      verifyPayment: async () => {
        throw new Error('unused');
      },
      capturePayment: async () => {
        throw new Error('unused');
      },
      getRefund: async () => {
        throw new Error('Refund lookup is not used by this checkout fixture');
      },
      refundPayment: async () => {
        throw new Error('unused');
      },
    };
    const attempt = await state.service.createPaymentIntent({
      actor: actor('user_1'),
      holdId: hold.id,
      idempotencyKey: 'upgrade-success-intent',
    });

    const result = await state.service.confirmPayment({
      actor: actor('user_1'),
      paymentId: 'pay-upgrade-success',
      paymentIntentId: attempt.paymentIntentId,
      holdId: hold.id,
      _idempotencyKey: 'upgrade-success-confirmation',
    });
    const upgradedSource = await state.deps.repositories.entitlements.getById(source.id);
    const replacement = result.entitlements[0];

    expect(result.order.grandTotalPaise).toBe(quote.pricing.grandTotalPaise);
    expect(upgradedSource).toMatchObject({
      status: 'void',
      upgradedToEntitlementId: replacement?.id,
    });
    expect(replacement).toMatchObject({
      status: 'valid',
      tierId: 'tier_premium',
      upgradeFromEntitlementId: source.id,
    });

    const replay = await state.service.confirmPayment({
      actor: actor('user_1'),
      paymentId: 'pay-upgrade-success',
      paymentIntentId: attempt.paymentIntentId,
      holdId: hold.id,
      _idempotencyKey: 'upgrade-success-confirmation-replay',
    });
    expect(replay.entitlements).toEqual(result.entitlements);
  });
});

describe('event-wide active paid-unit limit', () => {
  it('fails closed when a restricted tier is quoted or held without an access grant', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog, 20);
    const publicQuote = await service.quote({
      actor: actor('user_1'),
      eventId: 'evt_1',
      lines: [{ tierId: 'tier_1', quantity: 1 }],
    });
    const publicTier = await catalog.getTierById('tier_1');
    expect(publicTier).not.toBeNull();
    if (!publicTier) return;
    await catalog.saveTier({
      ...publicTier,
      accessMode: 'code',
      version: publicTier.version + 1,
    });

    await expect(
      service.quote({
        actor: actor('user_1'),
        eventId: 'evt_1',
        lines: [{ tierId: 'tier_1', quantity: 1 }],
      }),
    ).rejects.toThrow(/Ticket tier .* not found/);
    await expect(
      service.createHold({
        actor: actor('user_1'),
        eventId: 'evt_1',
        organizationId: 'org_1',
        lines: publicQuote.pricing.lines.map((line) => ({
          tierId: line.tierId,
          tierName: line.tierName,
          quantity: line.quantity,
          unitPricePaise: line.unitPricePaise,
        })),
        pricing: publicQuote.pricing,
        appliedPromoCode: null,
        attribution: null,
        idempotencyKey: 'direct-restricted-tier-hold',
      }),
    ).rejects.toThrow(/Ticket tier .* not found/);
  });

  it('allows ten held admission units across mixed tiers and refuses the eleventh', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog, 20);
    await seedAdditionalTier(catalog, 'tier_2', 2);

    await holdLinesFor(service, 'user_1', 'ten', [
      { tierId: 'tier_1', quantity: 6 },
      { tierId: 'tier_2', quantity: 2 },
    ]);
    await expect(
      holdLinesFor(service, 'user_1', 'eleven', [{ tierId: 'tier_2', quantity: 1 }]),
    ).rejects.toThrow(/maximum of 10 paid admission units/);
  });

  it('keeps concurrent holds within ten units by hold sequence', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog, 20);
    const attempts = await Promise.allSettled([
      holdLinesFor(service, 'user_1', 'tab-a', [{ tierId: 'tier_1', quantity: 6 }]),
      holdLinesFor(service, 'user_1', 'tab-b', [{ tierId: 'tier_1', quantity: 6 }]),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
  });

  it('snapshots per-person group shape and reserves one admission per attendee', async () => {
    const { catalog, service } = await build();
    await seedAdditionalTier(catalog, 'group', 3, 'per_person', 3);

    const hold = await holdLinesFor(service, 'user_1', 'group-hold', [
      { tierId: 'group', quantity: 1 },
    ]);

    expect(hold.lines[0]).toMatchObject({
      tierId: 'group',
      quantity: 1,
      guestCount: 3,
      admissionMode: 'per_person',
    });
    await expect(
      holdLinesFor(service, 'user_2', 'group-over-capacity', [{ tierId: 'group', quantity: 1 }]),
    ).rejects.toThrow(/Insufficient inventory/);
  });

  it('applies tier per-user caps to per-person group attendees', async () => {
    const { catalog, service } = await build();
    await catalog.saveTier(
      createTicketTier({
        id: 'capped-group',
        eventId: 'evt_1',
        organizationId: 'org_1',
        name: 'Capped group',
        priceInPaise: 50_000,
        quantity: 10,
        guestCount: 3,
        admissionMode: 'per_person',
        maxPerUser: 2,
        now: NOW,
      }),
    );

    await expect(
      holdLinesFor(service, 'user_1', 'capped-group-hold', [
        { tierId: 'capped-group', quantity: 1 },
      ]),
    ).rejects.toThrow(/maximum of 2 per user/);
  });
});

describe('an event must be on sale to take payment', () => {
  it('refuses a hold on a draft event', async () => {
    const { catalog, service } = await build({ eventStatus: 'draft' });
    await seedTier(catalog);

    await expect(holdFor(service, 'user_1', 'k1')).rejects.toThrow(
      /not on sale|unavailable|published/i,
    );
  });

  it('refuses a hold on a cancelled event', async () => {
    const { catalog, service } = await build({ eventStatus: 'cancelled' });
    await seedTier(catalog);

    await expect(holdFor(service, 'user_1', 'k1')).rejects.toThrow(
      /not on sale|unavailable|cancel/i,
    );
  });
});

describe('a promo code must be redeemable', () => {
  const promo = (overrides: Record<string, unknown> = {}) =>
    createPromoCode({
      id: 'promo_1',
      eventId: 'evt_1',
      organizationId: 'org_1',
      code: 'SAVE50',
      discountType: 'percent',
      discountValue: 50,
      discountFundingOwner: 'host',
      now: NOW,
      ...overrides,
    });

  it('does not apply an expired code', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog);
    await catalog.savePromo(promo({ endsAt: '2026-01-01T00:00:00.000Z' }));

    await expect(holdFor(service, 'user_1', 'k1', 'SAVE50')).rejects.toThrow(
      /expired|not valid|ended/i,
    );
  });

  it('does not apply a code that has not started', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog);
    await catalog.savePromo(promo({ startsAt: '2027-01-01T00:00:00.000Z' }));

    await expect(holdFor(service, 'user_1', 'k1', 'SAVE50')).rejects.toThrow(
      /not started|not valid|not yet/i,
    );
  });

  it('does not apply a deactivated code', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog);
    await catalog.savePromo({ ...promo(), isActive: false });

    await expect(holdFor(service, 'user_1', 'k1', 'SAVE50')).rejects.toThrow(
      /not active|not valid|deactivated|inactive/i,
    );
  });

  it('does not apply a code whose redemption limit is used up', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog);
    await catalog.savePromo({ ...promo({ maxRedemptions: 5 }), redemptionCount: 5 });

    await expect(holdFor(service, 'user_1', 'k1', 'SAVE50')).rejects.toThrow(
      /limit|used|redeemed|exhausted/i,
    );
  });
});

describe('inventory is never oversold', () => {
  // Fixed: hold positions are assigned in a transaction and capacity is judged
  // against the holds ordered at or before a hold. Proven against a real Firestore
  // in firestore-inventory.integration.test.ts; this is the in-memory check.
  it('lets only one of two simultaneous buyers reserve the last ticket', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog, 1);

    const results = await Promise.allSettled([
      holdFor(service, 'user_a', 'key-a'),
      holdFor(service, 'user_b', 'key-b'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('keeps a seat taken while its order is waiting on a refund', async () => {
    const { catalog, orders, carts, service } = await build();
    await seedTier(catalog, 1);
    const hold = await holdFor(service, 'user_a', 'key-a');
    await orders.save({
      id: 'ORD-1',
      eventId: 'evt_1',
      organizationId: 'org_1',
      userId: 'user_a',
      status: 'refund_requested',
      lines: hold.lines.map((l) => ({ ...l, subtotalPaise: l.unitPricePaise * l.quantity })),
      version: 1,
    } as unknown as Order);
    await carts.release(hold.id);

    // The buyer still holds a valid ticket, so the seat must still be unavailable.
    await expect(holdFor(service, 'user_b', 'key-b')).rejects.toThrow(/inventory/i);
  });
});

describe('an idempotency key never reaches another buyer’s hold', () => {
  it('does not return user A’s hold to user B for the same key', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog, 5);
    const a = await holdFor(service, 'user_a', 'shared-key');

    const b = await holdFor(service, 'user_b', 'shared-key').catch(() => null);

    expect(b === null || b.id !== a.id || b.userId === 'user_b').toBe(true);
    expect(b?.userId ?? 'user_b').toBe('user_b');
  });
});

describe('payment is refused once the event stops being on sale', () => {
  it('will not start a payment for a hold on an event that was cancelled meanwhile', async () => {
    const { catalog, events, service } = await build();
    await seedTier(catalog);
    const hold = await holdFor(service, 'user_1', 'k1');
    const stored = await events.getById('evt_1');
    if (!stored) throw new Error('event missing');
    await events.save({
      ...transitionEvent(stored, 'cancelled', NOW),
      version: stored.version + 1,
    });

    await expect(
      service.createPaymentIntent({
        actor: actor('user_1'),
        holdId: hold.id,
        idempotencyKey: 'pi-1',
      }),
    ).rejects.toThrow(/not on sale/i);
  });
});

describe('payment retries respect a pending refund lock', () => {
  it('does not issue tickets when a late callback resumes a refund-requested order', async () => {
    const { catalog, orders, service, deps } = await build();
    await seedTier(catalog);
    const hold = await holdFor(service, 'user_1', 'refund-retry-hold');
    const order = {
      id: 'order-refund-requested',
      eventId: hold.eventId,
      organizationId: 'org_1',
      userId: 'user_1',
      status: 'refund_requested',
      paymentId: 'pay-refund-requested',
      paymentIntentId: 'pi-refund-requested',
      version: 1,
    } as unknown as Order;
    await orders.save(order);
    // A legitimate replay retains the original server-owned provider binding.
    await deps.repositories.cartReservations.bindProviderOrder(hold.id, 'pi-refund-requested');

    const result = await service.confirmPayment({
      actor: actor('user_1'),
      paymentId: order.paymentId ?? '',
      paymentIntentId: order.paymentIntentId ?? '',
      holdId: hold.id,
      _idempotencyKey: 'late-refund-requested-retry',
    });

    expect(result.order.status).toBe('refund_requested');
    expect(result.entitlements).toEqual([]);
    expect(await deps.repositories.entitlements.getByOrderId(order.id)).toEqual([]);
  });
});

describe('promo redemption limits count every redemption record', () => {
  const limited = (overrides: Record<string, unknown>) =>
    createPromoCode({
      id: 'promo_1',
      eventId: 'evt_1',
      organizationId: 'org_1',
      code: 'ONCE',
      discountType: 'percent',
      discountValue: 10,
      discountFundingOwner: 'host',
      now: NOW,
      ...overrides,
    });

  const record = (promoId: string, userId = 'user_9') => ({
    id: `RED-${promoId}-${userId}`,
    promoId,
    orderId: `ORD-${promoId}-${userId}`,
    userId,
    redeemedAt: NOW.toISOString(),
  });

  it('stops a code once its total limit is reached, whether recorded by promo id or by code', async () => {
    for (const recordedUnder of ['promo_1', 'ONCE']) {
      const { catalog, redemptions, service } = await build();
      await seedTier(catalog);
      await catalog.savePromo(limited({ maxRedemptions: 1 }));
      await redemptions.create(record(recordedUnder));

      await expect(holdFor(service, 'user_1', 'k1', 'ONCE')).rejects.toThrow(/redemption limit/i);
    }
  });

  it('still allows a code below its limit', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog);
    await catalog.savePromo(limited({ maxRedemptions: 2 }));

    const hold = await holdFor(service, 'user_1', 'k1', 'ONCE');

    expect(hold.pricing.discountPaise).toBe(10_000);
  });

  it('stops one buyer using a per-user-limited code twice, but not a different buyer', async () => {
    const { catalog, redemptions, service } = await build();
    await seedTier(catalog);
    await catalog.savePromo(limited({ maxPerUser: 1 }));
    await redemptions.create(record('promo_1', 'user_1'));

    await expect(holdFor(service, 'user_1', 'k1', 'ONCE')).rejects.toThrow(/already used/i);
    await expect(holdFor(service, 'user_2', 'k2', 'ONCE')).resolves.toBeDefined();
  });
});

describe('a held seat can be re-requested by its own buyer', () => {
  it('replays the same hold for the same buyer and key', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog, 5);

    const first = await holdFor(service, 'user_a', 'same-key');
    const again = await holdFor(service, 'user_a', 'same-key');

    expect(again.id).toBe(first.id);
  });
});

describe('an amount the payment provider would refuse is refused up front', () => {
  it('rejects a paid total under ₹1 at quote, before any seat is held', async () => {
    const { catalog, carts, service } = await build();
    await catalog.saveTier(
      createTicketTier({
        id: 'tier_1',
        eventId: 'evt_1',
        organizationId: 'org_1',
        name: 'Tiny',
        priceInPaise: 50,
        quantity: 5,
        now: NOW,
      }),
    );

    await expect(holdFor(service, 'user_1', 'k1')).rejects.toThrow(/at least ₹1/);
    expect(carts.reservations.size).toBe(0);
  });

  it('still allows a free ticket', async () => {
    const { catalog, service } = await build();
    await catalog.saveTier(
      createTicketTier({
        id: 'tier_1',
        eventId: 'evt_1',
        organizationId: 'org_1',
        name: 'Free',
        accessType: 'RSVP',
        quantity: 5,
        now: NOW,
      }),
    );

    await expect(holdFor(service, 'user_1', 'k1')).resolves.toBeDefined();
  });

  it('does not convert a free RSVP into paid checkout through an add-on', async () => {
    const { catalog, service } = await build();
    await catalog.saveTier(
      createTicketTier({
        id: 'tier_1',
        eventId: 'evt_1',
        organizationId: 'org_1',
        name: 'Free',
        accessType: 'RSVP',
        quantity: 5,
        now: NOW,
      }),
    );
    const addon = createTicketAddon({
      id: 'addon-rsvp',
      eventId: 'evt_1',
      organizationId: 'org_1',
      name: 'Parking pass',
      kind: 'parking',
      priceInPaise: 5_000,
      quantity: 5,
      now: NOW,
    });
    await catalog.saveTicketAddon(addon);

    await expect(
      service.quote({
        actor: actor('user_rsvp_addon'),
        eventId: 'evt_1',
        lines: [
          {
            tierId: 'tier_1',
            quantity: 1,
            ticketAddons: [{ addonId: addon.id, quantityPerEntitlement: 1 }],
          },
        ],
      }),
    ).rejects.toThrow(/cannot be purchased with a free RSVP/);
  });

  it('still allows the smallest chargeable total (exactly 100 paise)', async () => {
    const { catalog, service } = await build();
    await catalog.saveTier(
      createTicketTier({
        id: 'tier_1',
        eventId: 'evt_1',
        organizationId: 'org_1',
        name: 'Cheap',
        priceInPaise: 92,
        quantity: 5,
        now: NOW,
      }),
    );

    // 92 + fees (5 + 2) + GST (1) is exactly 100 paise.
    const hold = await holdFor(service, 'user_1', 'k1');
    expect(hold.pricing.grandTotalPaise).toBe(100);
  });

  it('quotes add-ons at the server catalog price and reserves their stock with the ticket hold', async () => {
    const { catalog, service, deps } = await build();
    await seedTier(catalog);
    const addon = createTicketAddon({
      id: 'addon-parking',
      eventId: 'evt_1',
      organizationId: 'org_1',
      name: 'Parking pass',
      kind: 'parking',
      priceInPaise: 10_000,
      quantity: 2,
      maxPerEntitlement: 2,
      now: NOW,
    });
    await catalog.saveTicketAddon(addon);

    const quote = await service.quote({
      actor: actor('user_addon_1'),
      eventId: 'evt_1',
      lines: [
        {
          tierId: 'tier_1',
          quantity: 1,
          ticketAddons: [{ addonId: addon.id, quantityPerEntitlement: 2 }],
        },
      ],
    });
    expect(quote.pricing).toMatchObject({
      admissionSubtotalPaise: 100_000,
      addOnSubtotalPaise: 20_000,
      subtotalPaise: 120_000,
      lines: [{ unitPricePaise: 120_000 }],
    });
    const hold = await service.createHold({
      actor: actor('user_addon_1'),
      eventId: 'evt_1',
      organizationId: 'org_1',
      lines: quote.pricing.lines.map((line) => ({
        tierId: line.tierId,
        tierName: line.tierName,
        quantity: line.quantity,
        unitPricePaise: line.unitPricePaise,
        admissionUnitPricePaise: line.admissionUnitPricePaise,
        coverUnitPricePaise: line.coverUnitPricePaise,
        ticketAddons: line.ticketAddons,
      })),
      pricing: quote.pricing,
      appliedPromoCode: quote.pricing.appliedPromoCode,
      attribution: null,
      idempotencyKey: 'hold-with-addons',
    });

    expect(hold.lines[0]?.ticketAddons).toEqual(quote.pricing.lines[0]?.ticketAddons);
    expect(await deps.inventory.getAvailableTicketAddonQuantity(addon.id)).toBe(0);
    const second = await service.quote({
      actor: actor('user_addon_2'),
      eventId: 'evt_1',
      lines: [
        {
          tierId: 'tier_1',
          quantity: 1,
          ticketAddons: [{ addonId: addon.id, quantityPerEntitlement: 1 }],
        },
      ],
    });
    await expect(
      service.createHold({
        actor: actor('user_addon_2'),
        eventId: 'evt_1',
        organizationId: 'org_1',
        lines: second.pricing.lines.map((line) => ({
          tierId: line.tierId,
          tierName: line.tierName,
          quantity: line.quantity,
          unitPricePaise: line.unitPricePaise,
          admissionUnitPricePaise: line.admissionUnitPricePaise,
          coverUnitPricePaise: line.coverUnitPricePaise,
          ticketAddons: line.ticketAddons,
        })),
        pricing: second.pricing,
        appliedPromoCode: second.pricing.appliedPromoCode,
        attribution: null,
        idempotencyKey: 'sold-out-addon',
      }),
    ).rejects.toThrow(/Insufficient inventory for a selected ticket add-on/);
  });

  it('blocks new add-on quotes and holds while the approval gate is off', async () => {
    const enabled = await build();
    await seedTier(enabled.catalog);
    const addon = createTicketAddon({
      id: 'addon-disabled',
      eventId: 'evt_1',
      organizationId: 'org_1',
      name: 'Parking pass',
      kind: 'parking',
      priceInPaise: 5_000,
      quantity: 5,
      now: NOW,
    });
    await enabled.catalog.saveTicketAddon(addon);
    const actorContext = actor('user_addon_disabled');
    const line = {
      tierId: 'tier_1',
      quantity: 1,
      ticketAddons: [{ addonId: addon.id, quantityPerEntitlement: 1 }],
    };
    const quote = await enabled.service.quote({
      actor: actorContext,
      eventId: 'evt_1',
      lines: [line],
    });
    const disabledConfig = createCoreConfig({
      redis: { url: 'redis://localhost:6379' },
      firestore: { projectId: 'test-project' },
      clock: { now: () => NOW },
      features: { m5TicketAddonsEnabled: false },
    });
    const disabled = new CheckoutService({ ...enabled.deps, config: disabledConfig });

    await expect(
      disabled.quote({ actor: actorContext, eventId: 'evt_1', lines: [line] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      disabled.createHold({
        actor: actorContext,
        eventId: 'evt_1',
        organizationId: 'org_1',
        lines: quote.pricing.lines.map((pricedLine) => ({
          tierId: pricedLine.tierId,
          tierName: pricedLine.tierName,
          quantity: pricedLine.quantity,
          unitPricePaise: pricedLine.unitPricePaise,
          admissionUnitPricePaise: pricedLine.admissionUnitPricePaise,
          coverUnitPricePaise: pricedLine.coverUnitPricePaise,
          ticketAddons: pricedLine.ticketAddons,
        })),
        pricing: quote.pricing,
        appliedPromoCode: null,
        attribution: null,
        idempotencyKey: 'addon-disabled-hold',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('M4 provider order uncertainty boundary', () => {
  it('allows only one provider POST for concurrent fresh attempt keys', async () => {
    const state = await build();
    await seedTier(state.catalog);
    const hold = await holdFor(state.service, 'user_1', 'm4-concurrent');
    const provider = new MemoryPaymentProvider('synthetic');
    state.deps.paymentProvider = provider;
    const create = vi.spyOn(provider, 'createOrder');
    const attempts = await Promise.allSettled(
      ['one', 'two'].map((idempotencyKey) =>
        state.service.createPaymentIntent({
          actor: actor('user_1'),
          holdId: hold.id,
          idempotencyKey,
        }),
      ),
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(attempts.some((attempt) => attempt.status === 'fulfilled')).toBe(true);
    const stored = await state.carts.getById(hold.id);
    expect(stored?.providerOrderCreation?.receipt.length).toBeLessThanOrEqual(40);
    expect(stored?.providerOrderCreation).toMatchObject({
      amountPaise: hold.pricing.grandTotalPaise,
      currency: 'INR',
      holdId: hold.id,
    });
  });

  it('recovers a lost create response after service restart without another POST', async () => {
    const state = await build();
    await seedTier(state.catalog);
    const hold = await holdFor(state.service, 'user_1', 'm4-lost-response');
    const provider = new MemoryPaymentProvider('synthetic');
    state.deps.paymentProvider = provider;
    const realCreate = provider.createOrder.bind(provider);
    const create = vi.spyOn(provider, 'createOrder');
    create.mockImplementationOnce(async (request) => {
      await realCreate(request);
      throw new Error('Lost provider response');
    });
    await expect(
      state.service.createPaymentIntent({
        actor: actor('user_1'),
        holdId: hold.id,
        idempotencyKey: 'first',
      }),
    ).rejects.toThrow();
    const restarted = new CheckoutService(state.deps);
    const recovered = await restarted.createPaymentIntent({
      actor: actor('user_1'),
      holdId: hold.id,
      idempotencyKey: 'fresh-key',
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect((await state.carts.getById(hold.id))?.providerOrderId).toBe(recovered.paymentIntentId);
  });

  it.each([
    'ambiguous',
    'wrong receipt',
    'wrong hold',
    'wrong event',
    'wrong organization',
    'wrong amount',
    'wrong currency',
    'unavailable',
  ] as const)('keeps uncertain creation closed when lookup is %s', async (failure) => {
    const state = await build();
    await seedTier(state.catalog);
    const hold = await holdFor(state.service, 'user_1', `m4-lookup-${failure}`);
    const provider = new MemoryPaymentProvider('synthetic');
    state.deps.paymentProvider = provider;
    const realCreate = provider.createOrder.bind(provider);
    const create = vi.spyOn(provider, 'createOrder').mockImplementationOnce(async (request) => {
      await realCreate(request);
      throw new Error('Lost provider response');
    });
    await expect(
      state.service.createPaymentIntent({
        actor: actor('user_1'),
        holdId: hold.id,
        idempotencyKey: 'first',
      }),
    ).rejects.toThrow();
    const snapshot = (await state.carts.getById(hold.id))?.providerOrderCreation;
    if (!snapshot) throw new Error('Expected a durable provider claim');
    const facts = await provider.findOrdersByReceipt(snapshot.receipt);
    const fact = facts[0];
    if (!fact) throw new Error('Expected a provider-created order');
    vi.spyOn(provider, 'findOrdersByReceipt').mockImplementation(async () => {
      if (failure === 'unavailable') throw new Error('Lookup offline');
      if (failure === 'ambiguous') return [fact, { ...fact, id: 'second-order' }];
      if (failure === 'wrong receipt') return [{ ...fact, receipt: 'other' }];
      if (failure === 'wrong hold')
        return [{ ...fact, metadata: { ...fact.metadata, holdId: 'other' } }];
      if (failure === 'wrong event')
        return [{ ...fact, metadata: { ...fact.metadata, eventId: 'other' } }];
      if (failure === 'wrong organization')
        return [{ ...fact, metadata: { ...fact.metadata, organizationId: 'other' } }];
      if (failure === 'wrong currency') return [{ ...fact, currency: 'USD' }];
      return [{ ...fact, amountPaise: fact.amountPaise + 1 }];
    });
    await expect(
      new CheckoutService(state.deps).createPaymentIntent({
        actor: actor('user_1'),
        holdId: hold.id,
        idempotencyKey: 'retry',
      }),
    ).rejects.toThrow(/requires_support/);
    expect(create).toHaveBeenCalledTimes(1);
    expect((await state.carts.getById(hold.id))?.providerOrderId).toBe(hold.providerOrderId);
    expect(await state.service.getPaymentRecoveryStatus(actor('user_1'), hold.id)).toMatchObject({
      status: 'requires_support',
      orderId: null,
    });
    await expect(state.service.getPaymentRecoveryStatus(actor('other'), hold.id)).rejects.toThrow();
  });

  it('never returns a newly bound provider order as payable when its hold expires during provider creation', async () => {
    const state = await build();
    await seedTier(state.catalog);
    const hold = await holdFor(state.service, 'user_1', 'm4-crossed-ttl');
    const provider = new MemoryPaymentProvider('synthetic');
    state.deps.paymentProvider = provider;
    const original = provider.createOrder.bind(provider);
    const create = vi.spyOn(provider, 'createOrder').mockImplementation(async (request) => {
      const result = await original(request);
      const latest = await state.carts.getById(hold.id);
      if (!latest) throw new Error('Missing claimed hold');
      state.carts.reservations.set(hold.id, {
        ...latest,
        expiresAt: new Date(Date.now() - 1).toISOString(),
      });
      return result;
    });
    await expect(
      state.service.createPaymentIntent({
        actor: actor('user_1'),
        holdId: hold.id,
        idempotencyKey: 'attempt',
      }),
    ).rejects.toThrow(/requires_support|expired/);
    expect((await state.carts.getById(hold.id))?.providerOrderId).toBeTruthy();
    await expect(
      state.service.createPaymentIntent({
        actor: actor('user_1'),
        holdId: hold.id,
        idempotencyKey: 'retry',
      }),
    ).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('recovers lost-response identity after TTL expiry without reopening payment or creating another order', async () => {
    const state = await build();
    await seedTier(state.catalog);
    const hold = await holdFor(state.service, 'user_1', 'm4-expired-uncertainty');
    const provider = new MemoryPaymentProvider('synthetic');
    state.deps.paymentProvider = provider;
    const original = provider.createOrder.bind(provider);
    const create = vi.spyOn(provider, 'createOrder').mockImplementationOnce(async (request) => {
      await original(request);
      throw new Error('Lost provider response');
    });
    await expect(
      state.service.createPaymentIntent({
        actor: actor('user_1'),
        holdId: hold.id,
        idempotencyKey: 'first',
      }),
    ).rejects.toThrow();
    const claimed = await state.carts.getById(hold.id);
    if (!claimed) throw new Error('Missing durable claim');
    state.carts.reservations.set(hold.id, {
      ...claimed,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    await expect(
      new CheckoutService(state.deps).createPaymentIntent({
        actor: actor('user_1'),
        holdId: hold.id,
        idempotencyKey: 'retry',
      }),
    ).rejects.toThrow(/expired/);
    expect((await state.carts.getById(hold.id))?.providerOrderId).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rechecks TTL when the durable claim observes an already bound concurrent winner', async () => {
    const state = await build();
    await seedTier(state.catalog);
    const hold = await holdFor(state.service, 'user_1', 'm4-bound-claim-race');
    const provider = new MemoryPaymentProvider('synthetic');
    state.deps.paymentProvider = provider;
    const realClaim = state.carts.claimProviderOrderCreation.bind(state.carts);
    vi.spyOn(state.carts, 'claimProviderOrderCreation').mockImplementationOnce(
      async (id, receipt, now) => {
        const winner = await realClaim(id, receipt, now);
        const snapshot = winner?.hold.providerOrderCreation;
        if (!snapshot) throw new Error('Missing winner claim');
        const order = await provider.createOrder({
          amountPaise: snapshot.amountPaise,
          currency: snapshot.currency,
          idempotencyKey: receipt,
          metadata: { holdId: hold.id, eventId: hold.eventId, organizationId: hold.organizationId },
        });
        await state.carts.bindProviderOrder(id, order.id);
        const latest = await state.carts.getById(id);
        if (!latest) throw new Error('Missing bound hold');
        state.carts.reservations.set(id, {
          ...latest,
          expiresAt: new Date(Date.now() - 1).toISOString(),
        });
        return realClaim(id, receipt, now);
      },
    );
    await expect(
      state.service.createPaymentIntent({
        actor: actor('user_1'),
        holdId: hold.id,
        idempotencyKey: 'contender',
      }),
    ).rejects.toThrow(/expired/);
    expect((await state.carts.getById(hold.id))?.providerOrderId).toBeTruthy();
  });

  it('does not repeat a provider POST when its outcome cannot be recovered', async () => {
    const state = await build();
    await seedTier(state.catalog);
    const hold = await holdFor(state.service, 'user_1', 'm4-unknown');
    const provider = new MemoryPaymentProvider('synthetic');
    state.deps.paymentProvider = provider;
    const create = vi
      .spyOn(provider, 'createOrder')
      .mockRejectedValue(new Error('Network timeout'));
    for (const key of ['one', 'two']) {
      await expect(
        state.service.createPaymentIntent({
          actor: actor('user_1'),
          holdId: hold.id,
          idempotencyKey: key,
        }),
      ).rejects.toThrow();
    }
    expect(create).toHaveBeenCalledTimes(1);
    expect((await state.carts.getById(hold.id))?.providerOrderCreation?.state).toBe(
      'requires_support',
    );
  });
});

describe('M4 mandatory fulfillment completion', () => {
  async function purchase() {
    const state = await build();
    await seedTier(state.catalog);
    const provider = new MemoryPaymentProvider('synthetic');
    state.deps.paymentProvider = provider;
    const hold = await holdFor(state.service, 'user_1', 'm4-completion');
    const attempt = await state.service.createPaymentIntent({
      actor: actor('user_1'),
      holdId: hold.id,
      idempotencyKey: 'attempt',
    });
    provider.simulateCapture(
      'pay-completion',
      hold.pricing.grandTotalPaise,
      attempt.paymentIntentId,
    );
    const confirm = () =>
      state.service.confirmPayment({
        actor: actor('user_1'),
        paymentId: 'pay-completion',
        paymentIntentId: attempt.paymentIntentId,
        holdId: hold.id,
        _idempotencyKey: 'confirm',
      });
    return { ...state, provider, hold, confirm };
  }

  it('confirms only with durable completion and original structured receipt facts', async () => {
    const f = await purchase();
    const result = await f.confirm();
    expect(result.order).toMatchObject({
      fulfillmentState: 'complete',
      bookedAt: f.hold.createdAt,
      receiptFacts: {
        currency: 'INR',
        grandTotalPaise: f.hold.pricing.grandTotalPaise,
        providerPaymentId: 'pay-completion',
      },
    });
    const event = (f.deps.outbox as MemoryOutboxStore)
      .all()
      .find((row) => row.type === 'order.fulfilled');
    expect(event).toMatchObject({
      payload: { payload: { receiptFacts: result.order.receiptFacts } },
    });
  });

  it('keeps partially journaled purchases pending and unusable until repair completes', async () => {
    const f = await purchase();
    vi.spyOn(f.deps.repositories.financialJournals, 'postBatch').mockRejectedValueOnce(
      new Error('Synthetic journal interruption'),
    );
    await expect(f.confirm()).rejects.toThrow(/journal interruption/);
    const order = await f.orders.getByPaymentId('pay-completion');
    if (!order) throw new Error('Paid order must be durable before repair');
    expect(order.fulfillmentState).toBe('pending');
    const tickets = await f.deps.repositories.entitlements.getByOrderId(order.id);
    expect(tickets).toHaveLength(1);
    const ticket = tickets[0];
    if (!ticket) throw new Error('Missing staged ticket');
    expect(ticket.fulfillmentRequired).toBe(true);
    const wallet = new TicketService(f.deps);
    expect(
      (await wallet.listForUser(actor('user_1'), { limit: 100, cursor: null })).items,
    ).toHaveLength(0);
    await expect(wallet.getById(ticket.id, actor('user_1'))).rejects.toThrow();
    expect(await wallet.getManagement(ticket.id, actor('user_1'))).toMatchObject({
      status: 'processing',
      canPresent: false,
      canTransfer: false,
      qrUnavailableReason: 'Payment is still processing.',
    });

    expect(
      (await f.deps.repositories.entitlements.claimAdmission(ticket.id, ticket.eventId)).admitted,
    ).toBe(false);
    expect((await f.service.getPaymentRecoveryStatus(actor('user_1'), f.hold.id)).status).toBe(
      'processing',
    );
    await f.service.repairFulfilment(order.id);
    expect((await f.orders.getById(order.id))?.fulfillmentState).toBe('complete');
    expect(
      (await f.deps.repositories.entitlements.claimAdmission(ticket.id, ticket.eventId)).admitted,
    ).toBe(true);
  });

  it('finds a durable capture stranded before the order write and repairs it only after provider re-verification', async () => {
    const f = await purchase();
    vi.spyOn(f.orders, 'save').mockRejectedValueOnce(
      new Error('Synthetic paid-order interruption'),
    );
    await expect(f.confirm()).rejects.toThrow(/paid-order interruption/);
    expect(await f.orders.getByPaymentId('pay-completion')).toBeNull();
    const lookup = vi.spyOn(f.provider, 'getPayment');
    const sweep = new FulfilmentRepairService(f.deps, f.service);
    const preview = await sweep.sweep({ dryRun: true, settleMs: 0 });
    expect(preview.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          paymentId: 'pay-completion',
          missing: ['order'],
          outcome: 'found',
        }),
      ]),
    );
    expect(lookup).not.toHaveBeenCalled();
    const repaired = await sweep.sweep({ dryRun: false, settleMs: 0 });
    expect(lookup).toHaveBeenCalledWith('pay-completion');
    expect(repaired.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paymentId: 'pay-completion', outcome: 'repaired' }),
      ]),
    );
    expect((await f.orders.getByPaymentId('pay-completion'))?.fulfillmentState).toBe('complete');
  });

  it('replays a completed purchase after a partial refund without reopening or overwriting its void ticket', async () => {
    const f = await purchase();
    const first = await f.confirm();
    const selected = first.entitlements[0];
    if (!selected) throw new Error('Missing completed ticket');
    const locked = lockOrderForRefund(first.order);
    await f.orders.save(locked);
    const refunded = applyOrderRefund(locked, 1000, undefined, 'REF-partial');
    await f.orders.save(refunded);
    const frozen = freezeEntitlementForRefund(selected, 'REF-partial');
    await f.deps.repositories.entitlements.save(frozen);
    const revoked = voidEntitlement(frozen, undefined, 'REF-partial');
    await f.deps.repositories.entitlements.save(revoked);
    const payment = await f.providerPayments.findByPaymentId('pay-completion');
    if (!payment) throw new Error('Missing capture');
    await f.providerPayments.save(
      applyProviderPaymentEvent(
        payment,
        {
          type: 'refund_processed',
          paymentId: payment.id,
          refundId: 'rfnd-partial',
          amountPaise: 1000,
          currency: payment.currency,
        },
        new Date(),
      ),
    );
    const replay = await f.confirm();
    expect(replay.order).toEqual(refunded);
    expect(await f.deps.repositories.entitlements.getById(selected.id)).toEqual(revoked);
  });

  it('rejects a second captured payment for an already converted hold without binding it as fulfilled', async () => {
    const f = await purchase();
    const first = await f.confirm();
    const providerOrderId = first.order.paymentIntentId;
    if (!providerOrderId) throw new Error('Missing first provider binding');
    f.provider.simulateCapture(
      'pay-contradictory-second',
      f.hold.pricing.grandTotalPaise,
      providerOrderId,
    );
    const verified = await f.provider.getPayment('pay-contradictory-second');
    if (!verified) throw new Error('Missing synthetic second capture');
    const tickets = await f.deps.repositories.entitlements.getByOrderId(first.order.id);
    const journals = await f.deps.repositories.financialJournals.findByOrderId(first.order.id);
    await expect(
      f.service.confirmPayment({
        actor: actor('user_1'),
        paymentId: verified.paymentId,
        paymentIntentId: providerOrderId,
        holdId: f.hold.id,
        _idempotencyKey: 'contradictory-capture',
        _verifiedPayment: verified,
      }),
    ).rejects.toThrow(/different payment|does not match/);
    expect(await f.orders.getByPaymentId(verified.paymentId)).toBeNull();
    expect(await f.providerPayments.findByPaymentId(verified.paymentId)).toMatchObject({
      orderId: null,
      processingState: 'requires_support',
      capturedPaise: f.hold.pricing.grandTotalPaise,
    });
    expect(await f.orders.getById(first.order.id)).toEqual(first.order);
    expect(await f.deps.repositories.entitlements.getByOrderId(first.order.id)).toEqual(tickets);
    expect(await f.deps.repositories.financialJournals.findByOrderId(first.order.id)).toEqual(
      journals,
    );
  });

  it('rejects an existing payment order with another provider binding before any fulfillment work', async () => {
    const f = await purchase();
    const first = await f.confirm();
    await f.orders.save({
      ...first.order,
      paymentIntentId: 'order-foreign',
      version: first.order.version + 1,
    });
    const post = vi.spyOn(f.deps.repositories.financialJournals, 'postBatch');
    const complete = vi.spyOn(f.orders, 'completeFulfilment');
    await expect(f.confirm()).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('converges concurrent callback/webhook confirmations on one complete sale and receipt intent', async () => {
    const f = await purchase();
    const results = await Promise.all([f.confirm(), f.confirm()]);
    expect(results.map(({ order }) => order.fulfillmentState)).toEqual(['complete', 'complete']);
    expect(results[0]?.order.id).toBe(results[1]?.order.id);
    expect(
      (f.deps.outbox as MemoryOutboxStore).all().filter((row) => row.type === 'order.fulfilled'),
    ).toHaveLength(1);
    const tickets = await f.deps.repositories.entitlements.getByOrderId(results[0]?.order.id ?? '');
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.version).toBe(1);
  });

  it('detects and repairs a missing mandatory order intent instead of reporting fulfilled', async () => {
    const f = await purchase();
    vi.spyOn(f.orders, 'completeFulfilment').mockRejectedValueOnce(
      new Error('Synthetic completion interruption'),
    );
    await expect(f.confirm()).rejects.toThrow();
    const order = await f.orders.getByPaymentId('pay-completion');
    if (!order) throw new Error('Missing durable paid order');
    expect((await f.service.assessFulfilment(order)).missing).toContain('order_outbox');
  });
});

describe('M4 captured admission failures use canonical compensation intake', () => {
  it.each(['capacity_unavailable', 'promotion_unavailable', 'event_unavailable'] as const)(
    'persists %s with original money, no admissions, and no provider refund POST',
    async (reason) => {
      const state = await build();
      state.deps.pricing = new PricingService({
        eventCatalog: state.catalog,
        bookingFeePolicy: async () => NON_PRODUCTION_BOOKING_FEE_POLICY,
      });
      await seedTier(state.catalog, 1);
      if (reason === 'promotion_unavailable')
        await state.catalog.savePromo(
          createPromoCode({
            id: 'PROMO-compensation',
            eventId: 'evt_1',
            organizationId: 'org_1',
            code: 'COMPENSATE',
            discountType: 'fixed',
            discountValue: 1000,
            discountFundingOwner: 'platform',
            maxRedemptions: 1,
          }),
        );
      const hold = await holdFor(
        state.service,
        'user_1',
        'compensation-original',
        reason === 'promotion_unavailable' ? 'COMPENSATE' : null,
      );
      const provider = new MemoryPaymentProvider('synthetic');
      state.deps.paymentProvider = provider;
      const attempt = await state.service.createPaymentIntent({
        actor: actor('user_1'),
        holdId: hold.id,
        idempotencyKey: 'attempt',
      });
      provider.simulateCapture(
        'pay-compensation',
        hold.pricing.grandTotalPaise,
        attempt.paymentIntentId,
      );
      const refund = vi.spyOn(provider, 'refundPayment');
      if (reason === 'capacity_unavailable') {
        const current = await state.carts.getById(hold.id);
        if (!current) throw new Error('Missing hold');
        state.carts.reservations.set(hold.id, {
          ...current,
          expiresAt: new Date(Date.now() - 1).toISOString(),
        });
        await holdFor(state.service, 'user_2', 'compensation-new-buyer');
      }
      if (reason === 'promotion_unavailable')
        await state.redemptions.create({
          id: 'RED-other',
          promoId: 'PROMO-compensation',
          orderId: 'ORD-other',
          userId: 'user_2',
          redeemedAt: new Date().toISOString(),
        });
      if (reason === 'event_unavailable') {
        const event = await state.events.getById('evt_1');
        if (!event) throw new Error('Missing event');
        await state.events.save(transitionEvent(event, 'cancelled'));
      }
      const confirm = () =>
        state.service.confirmPayment({
          actor: actor('user_1'),
          holdId: hold.id,
          paymentId: 'pay-compensation',
          paymentIntentId: attempt.paymentIntentId,
          _idempotencyKey: 'confirm',
        });
      const result = await confirm();
      expect(result.order).toMatchObject({
        status: 'refund_requested',
        fulfillmentState: 'pending',
        bookedAt: hold.createdAt,
        compensationRequired: { reason },
      });
      expect(result.entitlements).toHaveLength(0);
      const requests = await state.deps.repositories.refundRequests.listByOrder(result.order.id);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        amountPaise: hold.pricing.grandTotalPaise,
        refundCause: 'fulfillment_failure',
        scope: 'amount_only',
        targetEntitlementIds: [],
        approversRequired: 1,
      });
      await confirm();
      expect(
        await state.deps.repositories.refundRequests.listByOrder(result.order.id),
      ).toHaveLength(1);
      expect(refund).not.toHaveBeenCalled();
      expect(
        (state.deps.outbox as MemoryOutboxStore)
          .all()
          .filter((row) => row.type === 'order.fulfilled'),
      ).toHaveLength(0);
    },
  );
});
