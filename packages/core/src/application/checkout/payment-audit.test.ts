import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { ForbiddenError } from '../../domain/errors.js';
import { issueEntitlements } from '../../domain/models/entitlement.js';
import { createPromoCode, createTicketTier } from '../../domain/models/event-catalog.js';
import { createEvent, transitionEvent } from '../../domain/models/event.js';
import { attachPaymentIntent, createOrder, markPaid } from '../../domain/models/order.js';
import { createTicketAddon } from '../../domain/models/ticket-addon.js';
import { MemoryFinancialJournalRepository } from '../../infrastructure/memory/memory-financial-journal-repository.js';
import { MemoryLeaderboardRepository } from '../../infrastructure/memory/memory-leaderboard-repository.js';
import { MemoryLedgerRepository } from '../../infrastructure/memory/memory-ledger-repository.js';
import { MemoryOnboardingRepository } from '../../infrastructure/memory/memory-onboarding-repository.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { MemoryPartnershipRepository } from '../../infrastructure/memory/memory-partnership-repository.js';
import { MemoryProviderFinancialEventRepository } from '../../infrastructure/memory/memory-provider-financial-event-repository.js';
import { MemoryProviderPaymentRepository } from '../../infrastructure/memory/memory-provider-payment-repository.js';
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

import { CheckoutService } from './checkout-service.js';

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
  const orders = new MemoryOrderRepository();
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
      catalog,
      cartReservations: carts,
      orders,
      entitlements: new MemoryEntitlementRepository(),
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
