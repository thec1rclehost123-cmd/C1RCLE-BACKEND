/**
 * ─── In-memory repository implementations ─────────────────────────────────────
 * Real implementations of the T07 repository ports for development and the v2
 * gateway wiring while real storage adapters are pending. Zero infra imports:
 * these never touch Firestore/Redis/Postgres.
 */

import type { EntityId } from '../../domain/identity.js';
import type {
  TicketTier,
  PromoCode,
  TablePackage,
  PromoterAssignment,
} from '../../domain/models/event-catalog.js';
import type { Event } from '../../domain/models/event.js';
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
} from '../../domain/ports/repositories.js';

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
    this.orgs.set(org.id, org);
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
    this.venues.set(venue.id, venue);
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
    this.requests.set(request.id, request);
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
    this.events.set(event.id, event);
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
