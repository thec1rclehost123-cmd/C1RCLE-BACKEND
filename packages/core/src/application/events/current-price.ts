import { eventSalesUnavailableReason } from '../../domain/models/event-policy.js';

import type { TicketTier } from '../../domain/models/event-catalog.js';
import type { Event } from '../../domain/models/event.js';
import type { InventoryService } from '../inventory/inventory-service.js';

/** Lowest price with a currently sellable tier and active pricing phase. */
export async function currentStartingPricePaise(input: {
  readonly event: Event;
  readonly tiers: readonly TicketTier[];
  readonly inventory: Pick<
    InventoryService,
    'getAvailableQuantity' | 'getAvailablePricingPhaseQuantity'
  >;
  readonly now: Date;
  readonly publicOnly?: boolean;
}): Promise<number | null> {
  const { event, tiers, inventory, now, publicOnly = false } = input;
  if (eventSalesUnavailableReason(event, now)) return null;
  const prices: number[] = [];
  const nowMs = now.getTime();

  for (const tier of tiers) {
    if (
      tier.status !== 'active' ||
      tier.audienceType === 'STUDENT' ||
      tier.audienceType === 'MEMBER' ||
      (publicOnly && (tier.accessMode ?? 'public') !== 'public') ||
      (tier.salesStartAt !== null && Date.parse(tier.salesStartAt) > nowMs) ||
      (tier.salesEndAt !== null && Date.parse(tier.salesEndAt) <= nowMs)
    ) {
      continue;
    }

    const availableAdmissions = await inventory.getAvailableQuantity(event.id, tier.id);
    const availableUnits =
      tier.admissionMode === 'per_person'
        ? Math.floor(availableAdmissions / Math.max(1, tier.guestCount ?? 1))
        : availableAdmissions;
    if (availableUnits <= 0) continue;

    if (tier.accessType === 'RSVP') {
      prices.push(0);
      continue;
    }

    const activePhase = (tier.pricingPhases ?? []).find(
      (phase) => Date.parse(phase.startsAt) <= nowMs && Date.parse(phase.endsAt) > nowMs,
    );
    if (!activePhase) {
      prices.push(tier.priceInPaise);
      continue;
    }
    const phaseAvailable =
      activePhase.quantity === null
        ? 1
        : await inventory.getAvailablePricingPhaseQuantity(event.id, tier.id, activePhase.id);
    prices.push(phaseAvailable > 0 ? activePhase.priceInPaise : tier.priceInPaise);
  }

  return prices.length ? Math.min(...prices) : null;
}
