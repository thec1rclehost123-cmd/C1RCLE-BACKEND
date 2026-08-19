import { VersionConflictError } from '../../domain/errors.js';
/**
 * ─── In-memory repository implementations ─────────────────────────────────────
 * Real implementations of the T07 repository ports for development and the v2
 * gateway wiring while real storage adapters are pending. Zero infra imports:
 * these never touch Firestore/Redis/Postgres.
 */

import type { EntityId } from '../../domain/identity.js';
import type { CartReservation } from '../../domain/models/cart-reservation.js';
import type { Entitlement } from '../../domain/models/entitlement.js';
import type {
  TicketTier,
  PromoCode,
  TablePackage,
  PromoterAssignment,
} from '../../domain/models/event-catalog.js';
import type { Event } from '../../domain/models/event.js';
import type { Order } from '../../domain/models/order.js';
import type { Organization, OrganizationMember } from '../../domain/models/organization.js';
import type { Venue, SlotRequest, VenueSlot } from '../../domain/models/venue.js';
import type {
  AnalyticsReadModelRepository,
  EventAnalytics,
  EventCatalogRepository,
  EventRepository,
  OrganizationOverview,
  OrganizationRepository,
  Page,
  PaginationQuery,
  SlotRequestRepository,
  TxContext,
  VenueRepository,
  VenueSlotRepository,
  OrderRepository,
  CartReservationRepository,
  EntitlementRepository,
  PromoRedemptionRepository,
} from '../../domain/ports/repositories.js';

/**
 * Compare-and-set for the memory driver — the same invariant the Firestore
 * adapter enforces (`compare-and-set.ts`): a write of version N must find N-1.
 *
 * Keeping both drivers identical is what lets one contract suite prove the
 * behaviour for both; a memory adapter that quietly allowed lost updates would
 * make every test that passes on it meaningless as evidence about production.
 *
 * The read and the write happen with no `await` between them, so on one event
 * loop exactly one of two concurrent writers can win.
 */
function casSet<T extends { id: EntityId; version: number }>(
  store: Map<EntityId, T>,
  next: T,
): void {
  if (next.version > 1) {
    const stored = store.get(next.id);
    const storedVersion = stored?.version ?? 0;
    if (storedVersion !== next.version - 1) {
      throw new VersionConflictError(next.version - 1, storedVersion);
    }
  }
  store.set(next.id, next);
}

export class MemoryOrganizationRepository implements OrganizationRepository {
  orgs = new Map<EntityId, Organization>();

  async getById(organizationId: EntityId): Promise<Organization | null> {
    return this.orgs.get(organizationId) ?? null;
  }

  async listForMember(userId: EntityId, query: PaginationQuery): Promise<Page<Organization>> {
    const all = [...this.orgs.values()].filter((o) => o.members.some((m) => m.userId === userId));
    return serializeSlice(all, query);
  }

  async listMembers(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<OrganizationMember>> {
    const org = this.orgs.get(organizationId);
    return serializeSlice(org ? org.members : [], query);
  }

  async getMember(organizationId: EntityId, userId: EntityId): Promise<OrganizationMember | null> {
    const org = this.orgs.get(organizationId);
    return org?.members.find((m) => m.userId === userId) ?? null;
  }

  async save(org: Organization, _tx?: TxContext | null): Promise<void> {
    casSet(this.orgs, org);
  }

  async delete(organizationId: EntityId, _tx?: TxContext | null): Promise<void> {
    this.orgs.delete(organizationId);
  }
}

export class MemoryVenueRepository implements VenueRepository {
  venues = new Map<EntityId, Venue>();

  async getById(venueId: EntityId): Promise<Venue | null> {
    return this.venues.get(venueId) ?? null;
  }

  async getBySlug(slug: string, organizationId: EntityId): Promise<Venue | null> {
    for (const venue of this.venues.values()) {
      if (venue.organizationId === organizationId && venue.public.slug === slug) return venue;
    }
    return null;
  }

  async listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Venue>> {
    const all = [...this.venues.values()].filter((v) => v.organizationId === organizationId);
    return serializeSlice(all, query);
  }

  async save(venue: Venue, _tx?: TxContext | null): Promise<void> {
    casSet(this.venues, venue);
  }
}

export class MemorySlotRequestRepository implements SlotRequestRepository {
  requests = new Map<EntityId, SlotRequest>();

  async getById(slotRequestId: EntityId): Promise<SlotRequest | null> {
    return this.requests.get(slotRequestId) ?? null;
  }

  async listByVenue(venueId: EntityId, query: PaginationQuery): Promise<Page<SlotRequest>> {
    const all = [...this.requests.values()].filter((r) => r.venueId === venueId);
    return serializeSlice(all, query);
  }

  async save(request: SlotRequest, _tx?: TxContext | null): Promise<void> {
    casSet(this.requests, request);
  }
}

export class MemoryVenueSlotRepository implements VenueSlotRepository {
  slots = new Map<EntityId, VenueSlot>();

  async listSlots(venueId: EntityId, _from: string, _to: string): Promise<VenueSlot[]> {
    return [...this.slots.values()].filter((s) => s.venueId === venueId);
  }

  async saveSlots(slots: VenueSlot[], _tx?: TxContext | null): Promise<void> {
    for (const slot of slots) this.slots.set(slot.id, slot);
  }
}

export class MemoryEventRepository implements EventRepository {
  events = new Map<EntityId, Event>();

  async getById(eventId: EntityId): Promise<Event | null> {
    return this.events.get(eventId) ?? null;
  }

  async listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Event>> {
    const all = [...this.events.values()].filter((e) => e.organizationId === organizationId);
    return serializeSlice(all, query);
  }

  async listByVenue(venueId: EntityId, query: PaginationQuery): Promise<Page<Event>> {
    const all = [...this.events.values()].filter((e) => e.venueId === venueId);
    return serializeSlice(all, query);
  }

  async listPublic(query: PaginationQuery): Promise<Page<Event>> {
    const all = [...this.events.values()].filter((e) => e.isPublic);
    return serializeSlice(all, query);
  }

  async save(event: Event, _tx?: TxContext | null): Promise<void> {
    casSet(this.events, event);
  }

  async delete(eventId: EntityId, _tx?: TxContext | null): Promise<void> {
    this.events.delete(eventId);
  }
}

export class MemoryEventCatalogRepository implements EventCatalogRepository {
  tiers = new Map<EntityId, TicketTier>();
  promos = new Map<EntityId, PromoCode>();
  tables = new Map<EntityId, TablePackage>();
  assignments = new Map<EntityId, PromoterAssignment>();

  async getTierById(tierId: EntityId): Promise<TicketTier | null> {
    return this.tiers.get(tierId) ?? null;
  }
  async listTiers(eventId: EntityId): Promise<TicketTier[]> {
    return [...this.tiers.values()].filter((t) => t.eventId === eventId);
  }
  async saveTier(tier: TicketTier, _tx?: TxContext | null): Promise<void> {
    this.tiers.set(tier.id, tier);
  }

  async getPromoById(promoId: EntityId): Promise<PromoCode | null> {
    return this.promos.get(promoId) ?? null;
  }
  async getPromoByCode(code: string, eventId: EntityId | null): Promise<PromoCode | null> {
    const normalized = code.toUpperCase().trim();
    for (const promo of this.promos.values()) {
      if (promo.code === normalized) {
        if (eventId === null || promo.eventId === eventId) return promo;
      }
    }
    return null;
  }
  async listPromos(eventId: EntityId, query: PaginationQuery): Promise<Page<PromoCode>> {
    const all = [...this.promos.values()].filter((p) => p.eventId === eventId);
    return serializeSlice(all, query);
  }
  async savePromo(promo: PromoCode, _tx?: TxContext | null): Promise<void> {
    this.promos.set(promo.id, promo);
  }

  async getTableById(tableId: EntityId): Promise<TablePackage | null> {
    return this.tables.get(tableId) ?? null;
  }
  async listTables(eventId: EntityId): Promise<TablePackage[]> {
    return [...this.tables.values()].filter((t) => t.eventId === eventId);
  }
  async saveTable(table: TablePackage, _tx?: TxContext | null): Promise<void> {
    this.tables.set(table.id, table);
  }

  async getAssignmentById(assignmentId: EntityId): Promise<PromoterAssignment | null> {
    return this.assignments.get(assignmentId) ?? null;
  }
  async listAssignments(eventId: EntityId): Promise<PromoterAssignment[]> {
    return [...this.assignments.values()].filter((a) => a.eventId === eventId);
  }
  async saveAssignment(assignment: PromoterAssignment, _tx?: TxContext | null): Promise<void> {
    this.assignments.set(assignment.id, assignment);
  }
}

export class MemoryAnalyticsReadModelRepository implements AnalyticsReadModelRepository {
  overviews = new Map<EntityId, OrganizationOverview>();
  analytics = new Map<EntityId, EventAnalytics>();

  async getOrganizationOverview(organizationId: EntityId): Promise<OrganizationOverview | null> {
    return this.overviews.get(organizationId) ?? null;
  }
  async getEventAnalytics(eventId: EntityId): Promise<EventAnalytics | null> {
    return this.analytics.get(eventId) ?? null;
  }
}

function serializeSlice<TItem>(all: TItem[], query: PaginationQuery): Page<TItem> {
  const limit = Math.min(Math.max(query.limit, 1), 100);
  const start = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
  const items = all.slice(start, start + limit);
  const nextCursor = start + limit < all.length ? String(start + limit) : null;
  return { items, total: all.length, nextCursor };
}

// ─── Phase 4: Order, CartReservation, Entitlement, PromoRedemption ───────────────

export class MemoryOrderRepository implements OrderRepository {
  orders = new Map<EntityId, Order>();
  byPaymentId = new Map<string, EntityId>();
  byIdempotencyKey = new Map<string, EntityId>();

  async getById(orderId: EntityId): Promise<Order | null> {
    return this.orders.get(orderId) ?? null;
  }

  async getByPaymentId(paymentId: string): Promise<Order | null> {
    const orderId = this.byPaymentId.get(paymentId);
    return orderId ? (this.orders.get(orderId) ?? null) : null;
  }

  async getByIdempotencyKey(key: string): Promise<Order | null> {
    const orderId = this.byIdempotencyKey.get(key);
    return orderId ? (this.orders.get(orderId) ?? null) : null;
  }

  async listByUser(userId: EntityId, query: PaginationQuery): Promise<Page<Order>> {
    const all = [...this.orders.values()].filter((o) => o.userId === userId);
    return serializeSlice(all, query);
  }

  async listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Order>> {
    const all = [...this.orders.values()].filter((o) => o.organizationId === organizationId);
    return serializeSlice(all, query);
  }

  async listByEvent(eventId: EntityId, query: PaginationQuery): Promise<Page<Order>> {
    const all = [...this.orders.values()].filter((o) => o.eventId === eventId);
    return serializeSlice(all, query);
  }

  async save(order: Order, _tx?: TxContext | null): Promise<void> {
    casSet(this.orders, order);
    if (order.paymentId) this.byPaymentId.set(order.paymentId, order.id);
    // Idempotency key is tracked externally via IdempotencyService
  }

  async delete(orderId: EntityId, _tx?: TxContext | null): Promise<void> {
    const order = this.orders.get(orderId);
    if (order?.paymentId) this.byPaymentId.delete(order.paymentId);
    this.orders.delete(orderId);
  }
}

export class MemoryCartReservationRepository implements CartReservationRepository {
  reservations = new Map<EntityId, CartReservation>();
  byIdempotencyKey = new Map<string, EntityId>();

  async create(reservation: CartReservation, _tx?: TxContext | null): Promise<void> {
    casSet(this.reservations, reservation);
    this.byIdempotencyKey.set(reservation.idempotencyKey, reservation.id);
  }

  async getById(reservationId: EntityId): Promise<CartReservation | null> {
    return this.reservations.get(reservationId) ?? null;
  }

  async getByIdempotencyKey(key: string): Promise<CartReservation | null> {
    const id = this.byIdempotencyKey.get(key);
    return id ? (this.reservations.get(id) ?? null) : null;
  }

  async release(reservationId: EntityId, _tx?: TxContext | null): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (reservation) {
      const released = { ...reservation, status: 'released' as const };
      casSet(this.reservations, released);
    }
  }

  async convertToOrder(
    reservationId: EntityId,
    orderId: EntityId,
    _tx?: TxContext | null,
  ): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (reservation) {
      const converted = { ...reservation, status: 'converted' as const, convertedOrderId: orderId };
      casSet(this.reservations, converted);
    }
  }

  async cleanupExpired(now: Date, _tx?: TxContext | null): Promise<number> {
    let count = 0;
    for (const [_id, reservation] of this.reservations) {
      if (reservation.status === 'active' && now.getTime() > Date.parse(reservation.expiresAt)) {
        const released = { ...reservation, status: 'released' as const };
        casSet(this.reservations, released);
        count++;
      }
    }
    return count;
  }
}

export class MemoryEntitlementRepository implements EntitlementRepository {
  entitlements = new Map<EntityId, Entitlement>();
  byOrderId = new Map<EntityId, EntityId[]>();

  async getById(entitlementId: EntityId): Promise<Entitlement | null> {
    return this.entitlements.get(entitlementId) ?? null;
  }

  async getByOrderId(orderId: EntityId): Promise<Entitlement[]> {
    const ids = this.byOrderId.get(orderId) ?? [];
    return ids
      .map((id) => this.entitlements.get(id))
      .filter((e): e is Entitlement => e !== undefined);
  }

  async listByUser(userId: EntityId, query: PaginationQuery): Promise<Page<Entitlement>> {
    const all = [...this.entitlements.values()].filter((e) => e.userId === userId);
    return serializeSlice(all, query);
  }

  async listByEvent(eventId: EntityId, query: PaginationQuery): Promise<Page<Entitlement>> {
    const all = [...this.entitlements.values()].filter((e) => e.eventId === eventId);
    return serializeSlice(all, query);
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Entitlement>> {
    const all = [...this.entitlements.values()].filter((e) => e.organizationId === organizationId);
    return serializeSlice(all, query);
  }

  async save(entitlement: Entitlement, _tx?: TxContext | null): Promise<void> {
    casSet(this.entitlements, entitlement);
    const ids = this.byOrderId.get(entitlement.orderId) ?? [];
    if (!ids.includes(entitlement.id)) {
      this.byOrderId.set(entitlement.orderId, [...ids, entitlement.id]);
    }
  }

  async saveMany(entitlements: Entitlement[], _tx?: TxContext | null): Promise<void> {
    for (const e of entitlements) await this.save(e);
  }

  async countValidByTier(tierId: EntityId): Promise<number> {
    return [...this.entitlements.values()].filter(
      (e) => e.tierId === tierId && e.status === 'valid',
    ).length;
  }
}

export class MemoryPromoRedemptionRepository implements PromoRedemptionRepository {
  redemptions = new Map<
    EntityId,
    { promoId: EntityId; orderId: EntityId; userId: EntityId | null; redeemedAt: string }
  >();
  byOrderId = new Map<EntityId, EntityId>();
  byPromoId = new Map<EntityId, EntityId[]>();
  byPromoAndUser = new Map<string, EntityId[]>(); // key: `${promoId}|${userId}`

  async create(
    redemption: {
      id: EntityId;
      promoId: EntityId;
      orderId: EntityId;
      userId: EntityId | null;
      redeemedAt: string;
    },
    _tx?: TxContext | null,
  ): Promise<void> {
    const key = `${redemption.promoId}|${redemption.userId ?? ''}`;
    const existing = this.byPromoAndUser.get(key) ?? [];
    if (existing.length > 0) {
      // Idempotent: if same order, allow; else conflict
      const existingId = this.byOrderId.get(redemption.orderId);
      if (existingId && existingId !== redemption.id) {
        throw new Error('Promo already redeemed for a different order');
      }
      return; // same order, same idempotency
    }
    this.redemptions.set(redemption.id, redemption);
    this.byOrderId.set(redemption.orderId, redemption.id);
    this.byPromoId.set(redemption.promoId, [
      ...(this.byPromoId.get(redemption.promoId) ?? []),
      redemption.id,
    ]);
    this.byPromoAndUser.set(key, [...existing, redemption.id]);
  }

  async getByOrderId(orderId: EntityId): Promise<{ promoId: EntityId; redeemedAt: string } | null> {
    const id = this.byOrderId.get(orderId);
    if (!id) return null;
    const redemption = this.redemptions.get(id);
    return redemption ? { promoId: redemption.promoId, redeemedAt: redemption.redeemedAt } : null;
  }

  async countByPromo(promoId: EntityId): Promise<number> {
    return (this.byPromoId.get(promoId) ?? []).length;
  }

  async countByPromoAndUser(promoId: EntityId, userId: EntityId): Promise<number> {
    return (this.byPromoAndUser.get(`${promoId}|${userId}`) ?? []).length;
  }
}
