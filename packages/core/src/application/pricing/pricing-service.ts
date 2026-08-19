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

    const pricingLines = lines.map((l) => {
      const tier = tierMap.get(l.tierId);
      if (!tier) throw new InvalidOperationError(`Tier ${l.tierId} not found for event ${eventId}`);
      return { tier, quantity: l.quantity };
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
