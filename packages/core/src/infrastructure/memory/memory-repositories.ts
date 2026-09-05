import { VersionConflictError } from '../../domain/errors.js';

/**
 * ─── In-memory repository implementations (Core domains for tests) ──────────────
 * Minimal implementations for the compare-and-set tests and the memory
 * storage driver (`buildRepositories` in `infrastructure/utils.ts`).
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
import type { Venue, VenueSlot, SlotRequest } from '../../domain/models/venue.js';
import type {
  EventRepository,
  OrganizationRepository,
  VenueRepository,
  SlotRequestRepository,
  VenueSlotRepository,
  EventCatalogRepository,
  AnalyticsReadModelRepository,
  CartReservationRepository,
  OrderRepository,
  EntitlementRepository,
  PromoRedemptionRepository,
  OrganizationOverview,
  EventAnalytics,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';

/**
 * Compare-and-set for the memory driver — the same invariant the Firestore
 * adapter enforces (`compare-and-set.ts`): a write of version N must find N-1.
 */
function casSet<T extends { id: EntityId; version: number }>(
  map: Map<EntityId, T>,
  entity: T,
): void {
  // A write of version N must find N-1 — including the "row is gone" case
  // (absent → version 0), which a deleted-then-resurrected write must not pass.
  // Mirrors `memory-onboarding-repository.ts`'s casSet.
  const existingVersion = map.get(entity.id)?.version ?? 0;
  if (existingVersion !== entity.version - 1) {
    throw new VersionConflictError(entity.version - 1, existingVersion);
  }
  map.set(entity.id, entity);
}

/**
 * Serializes a paginated slice of an in-memory array, cursored on an explicit
 * key. Needed because not every paged entity carries an `id`:
 * `OrganizationMember` is keyed by `userId` alone, and the previous
 * `(items[last] as any).id` silently produced an `undefined` cursor for it, so
 * member pagination never advanced past the first page.
 */
function serializeSliceBy<T>(
  all: T[],
  query: PaginationQuery,
  getCursor: (item: T) => EntityId,
): Page<T> {
  const { cursor, limit } = query;
  const start = cursor ? all.findIndex((item) => getCursor(item) === cursor) + 1 : 0;
  const end = Math.min(start + limit, all.length);
  const items = all.slice(start, end);
  const last = items[items.length - 1];
  const nextCursor = end < all.length && last ? getCursor(last) : null;
  return { items, total: all.length, nextCursor };
}

/** Serializes a paginated slice of an in-memory array cursored on `id`. */
function serializeSlice<T extends { id: EntityId }>(all: T[], query: PaginationQuery): Page<T> {
  return serializeSliceBy(all, query, (item) => item.id);
}

export class MemoryEventRepository implements EventRepository {
  events = new Map<EntityId, Event>();

  async getById(eventId: EntityId): Promise<Event | null> {
    return this.events.get(eventId) ?? null;
  }

  async findById(eventId: EntityId): Promise<Event | null> {
    return this.getById(eventId);
  }

  async getBySlug(slug: string): Promise<Event | null> {
    for (const event of this.events.values()) {
      if (event.slug === slug) return event;
    }
    return null;
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

export class MemoryOrganizationRepository implements OrganizationRepository {
  organizations = new Map<EntityId, Organization>();
  members = new Map<string, OrganizationMember>(); // key: `${orgId}|${userId}`

  async getById(organizationId: EntityId): Promise<Organization | null> {
    return this.organizations.get(organizationId) ?? null;
  }

  async getBySlug(slug: string): Promise<Organization | null> {
    for (const org of this.organizations.values()) {
      if (org.slug === slug) return org;
    }
    return null;
  }

  async listForMember(userId: EntityId, query: PaginationQuery): Promise<Page<Organization>> {
    const all = [...this.organizations.values()].filter((org) =>
      org.members?.some((m) => m.userId === userId),
    );
    return serializeSlice(all, query);
  }

  async listMembers(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<OrganizationMember>> {
    const all: OrganizationMember[] = [];
    for (const [key, member] of this.members) {
      if (key.startsWith(`${organizationId}|`)) {
        all.push(member);
      }
    }
    return serializeSliceBy(all, query, (member) => member.userId);
  }

  async getMember(organizationId: EntityId, userId: EntityId): Promise<OrganizationMember | null> {
    return this.members.get(`${organizationId}|${userId}`) ?? null;
  }

  async save(org: Organization, _tx?: TxContext | null): Promise<void> {
    casSet(this.organizations, org);
    for (const member of org.members ?? []) {
      this.members.set(`${org.id}|${member.userId}`, member);
    }
  }

  async delete(organizationId: EntityId, _tx?: TxContext | null): Promise<void> {
    this.organizations.delete(organizationId);
    for (const key of this.members.keys()) {
      if (key.startsWith(`${organizationId}|`)) this.members.delete(key);
    }
  }
}

export class MemoryVenueRepository implements VenueRepository {
  venues = new Map<EntityId, Venue>();

  async getById(venueId: EntityId): Promise<Venue | null> {
    return this.venues.get(venueId) ?? null;
  }

  async getBySlug(slug: string, organizationId: EntityId): Promise<Venue | null> {
    for (const venue of this.venues.values()) {
      if (venue.public.slug === slug && venue.organizationId === organizationId) return venue;
    }
    return null;
  }

  async getBySlugGlobal(slug: string): Promise<Venue | null> {
    for (const venue of this.venues.values()) {
      if (venue.public.slug === slug) return venue;
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
  slots = new Map<EntityId, VenueSlot[]>(); // key: venueId

  async listSlots(venueId: EntityId, from: string, to: string): Promise<VenueSlot[]> {
    return (this.slots.get(venueId) ?? []).filter(
      (slot) => slot.startTime >= from && slot.startTime <= to,
    );
  }

  async saveSlots(slots: VenueSlot[], _tx?: TxContext | null): Promise<void> {
    const first = slots[0];
    if (!first) return;
    const existing = this.slots.get(first.venueId) ?? [];
    const byId = new Map(existing.map((s) => [s.id, s] as const));
    for (const slot of slots) byId.set(slot.id, slot);
    this.slots.set(first.venueId, [...byId.values()]);
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

  async findWalkInTier(eventId: EntityId): Promise<TicketTier | null> {
    return (
      [...this.tiers.values()].find((t) => t.eventId === eventId && t.entryType === 'walkin') ??
      null
    );
  }

  async findDineInTier(eventId: EntityId): Promise<TicketTier | null> {
    return (
      [...this.tiers.values()].find((t) => t.eventId === eventId && t.entryType === 'dinein') ??
      null
    );
  }

  async saveTier(tier: TicketTier, _tx?: TxContext | null): Promise<void> {
    casSet(this.tiers, tier);
  }

  async getPromoById(promoId: EntityId): Promise<PromoCode | null> {
    return this.promos.get(promoId) ?? null;
  }

  async getPromoByCode(code: string, eventId: EntityId | null): Promise<PromoCode | null> {
    const normalized = code.toUpperCase().trim();
    for (const promo of this.promos.values()) {
      if (promo.code === normalized && (eventId === null || promo.eventId === eventId))
        return promo;
    }
    return null;
  }

  async listPromos(eventId: EntityId, query: PaginationQuery): Promise<Page<PromoCode>> {
    const all = [...this.promos.values()].filter((p) => p.eventId === eventId);
    return serializeSlice(all, query);
  }

  async savePromo(promo: PromoCode, _tx?: TxContext | null): Promise<void> {
    casSet(this.promos, promo);
  }

  async getTableById(tableId: EntityId): Promise<TablePackage | null> {
    return this.tables.get(tableId) ?? null;
  }

  async listTables(eventId: EntityId): Promise<TablePackage[]> {
    return [...this.tables.values()].filter((t) => t.eventId === eventId);
  }

  async saveTable(table: TablePackage, _tx?: TxContext | null): Promise<void> {
    casSet(this.tables, table);
  }

  async getAssignmentById(assignmentId: EntityId): Promise<PromoterAssignment | null> {
    return this.assignments.get(assignmentId) ?? null;
  }

  async listAssignments(eventId: EntityId): Promise<PromoterAssignment[]> {
    return [...this.assignments.values()].filter((a) => a.eventId === eventId);
  }

  async saveAssignment(assignment: PromoterAssignment, _tx?: TxContext | null): Promise<void> {
    casSet(this.assignments, assignment);
  }
}

export class MemoryAnalyticsReadModelRepository implements AnalyticsReadModelRepository {
  overviews = new Map<EntityId, OrganizationOverview>();
  eventAnalytics = new Map<EntityId, EventAnalytics>();

  async getOrganizationOverview(organizationId: EntityId): Promise<OrganizationOverview | null> {
    return this.overviews.get(organizationId) ?? null;
  }

  async getEventAnalytics(eventId: EntityId): Promise<EventAnalytics | null> {
    return this.eventAnalytics.get(eventId) ?? null;
  }
}

export class MemoryCartReservationRepository implements CartReservationRepository {
  reservations = new Map<EntityId, CartReservation>();
  byIdempotencyKey = new Map<string, CartReservation>();

  async create(reservation: CartReservation, _tx?: TxContext | null): Promise<void> {
    this.reservations.set(reservation.id, reservation);
    if (reservation.idempotencyKey) {
      this.byIdempotencyKey.set(reservation.idempotencyKey, reservation);
    }
  }

  async getById(reservationId: EntityId): Promise<CartReservation | null> {
    return this.reservations.get(reservationId) ?? null;
  }

  async getByIdempotencyKey(key: string): Promise<CartReservation | null> {
    return this.byIdempotencyKey.get(key) ?? null;
  }

  async release(reservationId: EntityId, _tx?: TxContext | null): Promise<void> {
    const r = this.reservations.get(reservationId);
    if (r) this.reservations.set(reservationId, { ...r, status: 'released' });
  }

  async convertToOrder(
    reservationId: EntityId,
    orderId: EntityId,
    _tx?: TxContext | null,
  ): Promise<void> {
    const r = this.reservations.get(reservationId);
    if (r) {
      this.reservations.set(reservationId, {
        ...r,
        status: 'converted',
        convertedOrderId: orderId,
      });
    }
  }

  async cleanupExpired(now: Date, _tx?: TxContext | null): Promise<number> {
    let count = 0;
    for (const [id, r] of this.reservations) {
      if (r.status === 'active' && Date.parse(r.expiresAt) <= now.getTime()) {
        this.reservations.set(id, { ...r, status: 'released' });
        count++;
      }
    }
    return count;
  }

  async listActiveByEvent(eventId: EntityId, now: Date): Promise<CartReservation[]> {
    return [...this.reservations.values()].filter(
      (r) =>
        r.eventId === eventId && r.status === 'active' && Date.parse(r.expiresAt) > now.getTime(),
    );
  }
}

export class MemoryOrderRepository implements OrderRepository {
  orders = new Map<EntityId, Order>();
  byPaymentId = new Map<string, Order>();

  async getById(orderId: EntityId): Promise<Order | null> {
    return this.orders.get(orderId) ?? null;
  }

  async getByPaymentId(paymentId: string): Promise<Order | null> {
    return this.byPaymentId.get(paymentId) ?? null;
  }

  async getByIdempotencyKey(_key: string): Promise<Order | null> {
    // The committed `Order` model carries no idempotency key — idempotent order
    // creation is anchored on the cart reservation (`HOLD-{idempotencyKey}`),
    // not the order. Kept to satisfy the port; always a miss for the memory driver.
    return null;
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
    if (order.paymentId) this.byPaymentId.set(order.paymentId, order);
  }
}

export class MemoryEntitlementRepository implements EntitlementRepository {
  entitlements = new Map<EntityId, Entitlement>();

  async getById(entitlementId: EntityId): Promise<Entitlement | null> {
    return this.entitlements.get(entitlementId) ?? null;
  }

  async findById(entitlementId: EntityId): Promise<Entitlement | null> {
    return this.getById(entitlementId);
  }

  async getByOrderId(orderId: EntityId): Promise<Entitlement[]> {
    return [...this.entitlements.values()].filter((e) => e.orderId === orderId);
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
  }

  async saveMany(entitlements: Entitlement[], _tx?: TxContext | null): Promise<void> {
    for (const e of entitlements) casSet(this.entitlements, e);
  }

  async countValidByTier(tierId: EntityId): Promise<number> {
    return [...this.entitlements.values()].filter(
      (e) => e.tierId === tierId && e.status === 'valid',
    ).length;
  }
}

interface PromoRedemptionRecord {
  id: EntityId;
  promoId: EntityId;
  orderId: EntityId;
  userId: EntityId | null;
  redeemedAt: string;
}

export class MemoryPromoRedemptionRepository implements PromoRedemptionRepository {
  redemptions = new Map<EntityId, PromoRedemptionRecord>();

  async create(redemption: PromoRedemptionRecord, _tx?: TxContext | null): Promise<void> {
    this.redemptions.set(redemption.id, redemption);
  }

  async getByOrderId(orderId: EntityId): Promise<{ promoId: EntityId; redeemedAt: string } | null> {
    for (const r of this.redemptions.values()) {
      if (r.orderId === orderId) return { promoId: r.promoId, redeemedAt: r.redeemedAt };
    }
    return null;
  }

  async countByPromo(promoId: EntityId): Promise<number> {
    return [...this.redemptions.values()].filter((r) => r.promoId === promoId).length;
  }

  async countByPromoAndUser(promoId: EntityId, userId: EntityId): Promise<number> {
    return [...this.redemptions.values()].filter(
      (r) => r.promoId === promoId && r.userId === userId,
    ).length;
  }
}
