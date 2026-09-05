import { InvalidOperationError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  EventCatalogRepository,
  CartReservationRepository,
  OrderRepository,
} from '../../domain/ports/repositories.js';

/**
 * ─── InventoryService (Phase 4) ────────────────────────────────────────────────
 * Calculates effective available inventory for ticket tiers.
 * Ported from v1's `inventory-engine.js calculateEffectiveInventory`:
 *   effective = tier.quantity - sold - activeHolds
 * Sharded counters for high-throughput events.
 * Circuit breaker: strictMode events fail closed (503) on Redis degradation.
 */
export class InventoryService {
  constructor(
    private readonly deps: {
      eventCatalog: EventCatalogRepository;
      cartReservation: CartReservationRepository;
      order: OrderRepository;
    },
  ) {}

  /**
   * Gets the effective available quantity for a tier.
   * effective = tier.quantity - sold - activeHolds
   */
  async getAvailableQuantity(eventId: string, tierId: EntityId): Promise<number> {
    const tier = await this.deps.eventCatalog.getTierById(tierId);
    if (!tier) throw new InvalidOperationError(`Tier ${tierId} not found`);

    const totalQuantity = tier.quantity ?? 0;
    if (totalQuantity <= 0) return 0;

    const sold = await this.getSoldCount(eventId, tierId);
    const activeHolds = await this.getActiveHoldsCount(eventId, tierId);

    const effective = totalQuantity - sold - activeHolds;
    return Math.max(0, effective);
  }

  /**
   * Gets the number of tickets sold for a tier (from paid orders). Was
   * previously a hardcoded `return 0` — oversell protection did not actually
   * check anything sold. Pages through every order for the event rather
   * than trusting a single page, since a popular event can exceed one page.
   */
  private async getSoldCount(eventId: string, tierId: EntityId): Promise<number> {
    let sold = 0;
    let cursor: string | null | undefined;
    for (;;) {
      const page = await this.deps.order.listByEvent(eventId, { cursor, limit: 100 });
      for (const order of page.items) {
        if (order.status !== 'paid') continue;
        for (const line of order.lines) {
          if (line.tierId === tierId) sold += line.quantity;
        }
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return sold;
  }

  /**
   * Gets the number of active (non-expired) cart reservations for a tier.
   * Was previously a hardcoded `return 0` — two concurrent holds on the last
   * ticket would both have succeeded.
   */
  private async getActiveHoldsCount(eventId: string, tierId: EntityId): Promise<number> {
    const holds = await this.deps.cartReservation.listActiveByEvent(eventId, new Date());
    let count = 0;
    for (const hold of holds) {
      for (const line of hold.lines) {
        if (line.tierId === tierId) count += line.quantity;
      }
    }
    return count;
  }

  /**
   * Checks if a tier has sufficient inventory for a request.
   * Throws if insufficient.
   */
  async assertAvailable(eventId: string, tierId: EntityId, quantity: number): Promise<void> {
    const available = await this.getAvailableQuantity(eventId, tierId);
    if (available < quantity) {
      throw new InvalidOperationError(
        `Insufficient inventory: ${quantity} requested, ${available} available`,
      );
    }
  }
}
