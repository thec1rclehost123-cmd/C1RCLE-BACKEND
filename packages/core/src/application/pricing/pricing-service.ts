import { InvalidOperationError } from '../../domain/errors.js';
import { calculatePricing } from '../../domain/models/pricing.js';

import type { EntityId } from '../../domain/identity.js';
import type { PromoCode } from '../../domain/models/event-catalog.js';
import type { PricingBreakdown } from '../../domain/models/pricing.js';
import type { EventCatalogRepository } from '../../domain/ports/repositories.js';

/**
 * ─── PricingService (Phase 4) ──────────────────────────────────────────────────
 * Thin wrapper around the domain pricing engine that adds event-catalog lookups.
 * Pure calculation with no side effects — same as `models/pricing.ts` but with
 * repository access for promo code validation.
 */
export class PricingService {
  constructor(private readonly deps: { eventCatalog: EventCatalogRepository }) {}

  /**
   * Calculates pricing for a set of lines with optional promo code.
   * Validates the promo code against the event catalog.
   */
  async calculate(input: {
    eventId: EntityId;
    lines: { tierId: EntityId; quantity: number }[];
    promoCode?: string | null;
  }): Promise<PricingBreakdown> {
    const { eventId, lines, promoCode } = input;

    // Load event catalog (tiers + promos)
    const catalog = await this.deps.eventCatalog.listTiers(eventId);
    const tierMap = new Map(catalog.map((t) => [t.id, t]));

    const now = Date.now();
    const pricingLines = lines.map((l) => {
      const tier = tierMap.get(l.tierId);
      if (!tier) throw new InvalidOperationError(`Tier ${l.tierId} not found for event ${eventId}`);
      if (tier.status !== 'active')
        throw new InvalidOperationError(`Tier ${tier.name} is not available`);
      if (tier.salesStartAt && Date.parse(tier.salesStartAt) > now)
        throw new InvalidOperationError(`${tier.name} sales have not started`);
      if (tier.salesEndAt && Date.parse(tier.salesEndAt) <= now)
        throw new InvalidOperationError(`${tier.name} sales have ended`);
      if (
        tier.minPerOrder !== null &&
        tier.minPerOrder !== undefined &&
        l.quantity < tier.minPerOrder
      ) {
        throw new InvalidOperationError(
          `${tier.name} requires at least ${tier.minPerOrder} ticket(s)`,
        );
      }
      if (
        tier.maxPerUser !== null &&
        tier.maxPerUser !== undefined &&
        l.quantity > tier.maxPerUser
      ) {
        throw new InvalidOperationError(
          `${tier.name} allows at most ${tier.maxPerUser} ticket(s) per user`,
        );
      }
      const phase = (tier.pricingPhases ?? []).find(
        (candidate) => Date.parse(candidate.startsAt) <= now && Date.parse(candidate.endsAt) > now,
      );
      const resolvedTier = phase ? { ...tier, priceInPaise: phase.priceInPaise } : tier;
      return { tier: resolvedTier, quantity: l.quantity };
    });

    let promo: PromoCode | null = null;
    if (promoCode) {
      promo = await this.deps.eventCatalog.getPromoByCode(promoCode, eventId);
      if (!promo) throw new InvalidOperationError(`Promo code ${promoCode} not found`);
    }

    const pricing = calculatePricing({
      lines: pricingLines,
      promo: promo ?? undefined,
      currency: 'INR',
    });

    return pricing;
  }
}
