import { InvalidOperationError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { CartReservation } from '../../domain/models/cart-reservation.js';
import type {
  EventCatalogRepository,
  CartReservationRepository,
  OrderRepository,
} from '../../domain/ports/repositories.js';

function unitsForLine(line: {
  quantity: number;
  guestCount?: number;
  admissionMode?: 'bundle' | 'per_person';
}): number {
  return line.quantity * (line.admissionMode === 'per_person' ? (line.guestCount ?? 1) : 1);
}

function addonUnitsForLine(line: {
  quantity: number;
  guestCount?: number;
  admissionMode?: 'bundle' | 'per_person';
  ticketAddons?: { addonId: EntityId; quantityPerEntitlement: number }[];
}): Map<EntityId, number> {
  const entitlements = unitsForLine(line);
  return new Map(
    (line.ticketAddons ?? []).map((addon) => [
      addon.addonId,
      entitlements * addon.quantityPerEntitlement,
    ]),
  );
}

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

  async getAvailableTicketAddonQuantity(addonId: EntityId): Promise<number> {
    const addon = await this.deps.eventCatalog.getTicketAddonById(addonId);
    if (!addon) throw new InvalidOperationError(`Ticket add-on ${addonId} not found`);
    let sold = 0;
    for (const order of await this.deps.order.listSeatClaims(addon.eventId)) {
      if (order.status !== 'paid' && order.status !== 'refund_requested') continue;
      for (const line of order.lines) sold += addonUnitsForLine(line).get(addonId) ?? 0;
    }
    let held = 0;
    for (const reservation of await this.deps.cartReservation.listActiveByEvent(
      addon.eventId,
      new Date(),
    )) {
      for (const line of reservation.lines) held += addonUnitsForLine(line).get(addonId) ?? 0;
    }
    return Math.max(0, addon.quantity - sold - held);
  }

  /**
   * Gets the number of tickets sold for a tier (from paid orders). Was
   * previously a hardcoded `return 0` — oversell protection did not actually
   * check anything sold. Pages through every order for the event rather
   * than trusting a single page, since a popular event can exceed one page.
   */
  private async getSoldCount(eventId: string, tierId: EntityId): Promise<number> {
    return (await this.getSoldByTier(eventId)).get(tierId) ?? 0;
  }

  /**
   * Seats sold per tier for an event, from ONE read of just each order's status
   * and lines. `refund_requested` still holds a valid ticket until the refund
   * actually settles, so its seat stays taken; only `refunded` gives it back.
   */
  private async getSoldByTier(eventId: string): Promise<Map<EntityId, number>> {
    const sold = new Map<EntityId, number>();
    for (const order of await this.deps.order.listSeatClaims(eventId)) {
      if (order.status !== 'paid' && order.status !== 'refund_requested') continue;
      for (const line of order.lines) {
        sold.set(line.tierId, (sold.get(line.tierId) ?? 0) + unitsForLine(line));
      }
    }
    return sold;
  }

  private async getActiveHoldsCount(eventId: string, tierId: EntityId): Promise<number> {
    const holds = await this.deps.cartReservation.listActiveByEvent(eventId, new Date());
    let count = 0;
    for (const hold of holds) {
      for (const line of hold.lines) {
        if (line.tierId === tierId) count += unitsForLine(line);
      }
    }
    return count;
  }

  /**
   * Checks if a tier has sufficient inventory for a request.
   * Throws if insufficient.
   */
  /**
   * Whether a hold that has just been stored still fits, judged against what is
   * sold plus the live holds ordered at or before it. Holds ordered after it are
   * ignored: they are judged against this one instead. Because hold positions are
   * assigned in a transaction (see `CartReservationRepository.create`), every
   * hold ordered before this one is already visible here, so of two buyers racing
   * for the last seat exactly one passes.
   *
   * Returns the name of the first tier that no longer fits, or null if all do.
   */
  async firstOverbookedTier(hold: CartReservation): Promise<EntityId | null> {
    const myPosition = hold.sequence ?? Number.MAX_SAFE_INTEGER;
    const live = await this.deps.cartReservation.listActiveByEvent(hold.eventId, new Date());
    const soldByTier = await this.getSoldByTier(hold.eventId);
    for (const line of hold.lines) {
      const tier = await this.deps.eventCatalog.getTierById(line.tierId);
      if (!tier) throw new InvalidOperationError(`Tier ${line.tierId} not found`);
      const capacity = tier.quantity ?? 0;
      const sold = soldByTier.get(line.tierId) ?? 0;
      let reserved = 0;
      for (const other of live) {
        // A hold from before positions existed counts as ahead of everything.
        const ahead = other.id === hold.id || (other.sequence ?? 0) <= myPosition;
        if (!ahead) continue;
        for (const otherLine of other.lines) {
          if (otherLine.tierId === line.tierId) reserved += unitsForLine(otherLine);
        }
      }
      if (sold + reserved > capacity) return line.tierId;
    }
    return null;
  }

  /** Applies hold sequence fairness to add-on stock just as it does to tickets. */
  async firstOverbookedTicketAddon(hold: CartReservation): Promise<EntityId | null> {
    const requested = new Map<EntityId, number>();
    for (const line of hold.lines) {
      for (const [addonId, quantity] of addonUnitsForLine(line)) {
        requested.set(addonId, (requested.get(addonId) ?? 0) + quantity);
      }
    }
    if (requested.size === 0) return null;

    const live = await this.deps.cartReservation.listActiveByEvent(hold.eventId, new Date());
    const myPosition = hold.sequence ?? Number.MAX_SAFE_INTEGER;
    const orders = await this.deps.order.listSeatClaims(hold.eventId);
    for (const [addonId] of requested) {
      const addon = await this.deps.eventCatalog.getTicketAddonById(addonId);
      if (!addon || addon.eventId !== hold.eventId) {
        throw new InvalidOperationError(`Ticket add-on ${addonId} is no longer available`);
      }
      let sold = 0;
      for (const order of orders) {
        if (order.status !== 'paid' && order.status !== 'refund_requested') continue;
        for (const line of order.lines) sold += addonUnitsForLine(line).get(addonId) ?? 0;
      }
      let reserved = 0;
      for (const other of live) {
        const ahead = other.id === hold.id || (other.sequence ?? 0) <= myPosition;
        if (!ahead) continue;
        for (const line of other.lines) reserved += addonUnitsForLine(line).get(addonId) ?? 0;
      }
      if (sold + reserved > addon.quantity) return addonId;
    }
    return null;
  }

  async assertAvailable(eventId: string, tierId: EntityId, quantity: number): Promise<void> {
    const available = await this.getAvailableQuantity(eventId, tierId);
    if (available < quantity) {
      throw new InvalidOperationError(
        `Insufficient inventory: ${quantity} requested, ${available} available`,
      );
    }
  }
}
