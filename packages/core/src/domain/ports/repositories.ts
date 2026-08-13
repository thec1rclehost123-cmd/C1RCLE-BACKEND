/**
 * ─── T07 repository interfaces (ports) ───────────────────────────────────────
 * Domain services depend on these interfaces — never on Firestore/Postgres.
 * Implementations: Firebase repositories now, MemoryRepository in tests,
 * Postgres later. No storage types appear in any signature.
 *
 * Write methods accept an optional transaction context; implementations map
 * it to the storage engine's own transaction primitive.
 */

import type { EntityId } from '../identity.js';
import type {
  TicketTier,
  PromoCode,
  TablePackage,
  PromoterAssignment,
} from '../models/event-catalog.js';
import type { Event } from '../models/event.js';
import type { Organization, OrganizationMember } from '../models/organization.js';
import type { Venue, VenueSlot, SlotRequest } from '../models/venue.js';

/** Opaque cursor into a paginated result set. */
export type Cursor = string;

/** Transaction/atomicity handle. Storage-agnostic. Routes pass `null`. */
export interface TxContext {
  readonly kind: 'tx';
  readonly id: string;
}

/** Standard paginated read outcome. `nextCursor` is null when exhausted. */
export interface Page<TItem> {
  items: TItem[];
  /** True total before paging (V1-proven `total`; 0 when the source lacks a count). */
  total: number;
  nextCursor: Cursor | null;
}

export interface PaginationQuery {
  /** Opaque cursor returned by the previous page. */
  cursor?: Cursor | null;
  /** 1–100; caller (route schema) enforces the bound too. */
  limit: number;
}

// ─── Organization ────────────────────────────────────────────────────────────

export interface OrganizationRepository {
  getById(organizationId: EntityId): Promise<Organization | null>;
  /** All orgs a user id belongs to as a member. */
  listForMember(userId: EntityId, query: PaginationQuery): Promise<Page<Organization>>;
  listMembers(organizationId: EntityId, query: PaginationQuery): Promise<Page<OrganizationMember>>;
  getMember(organizationId: EntityId, userId: EntityId): Promise<OrganizationMember | null>;
  save(org: Organization, tx?: TxContext | null): Promise<void>;
  delete(organizationId: EntityId, tx?: TxContext | null): Promise<void>;
}

// ─── Venue ───────────────────────────────────────────────────────────────────

export interface VenueRepository {
  getById(venueId: EntityId): Promise<Venue | null>;
  getBySlug(slug: string, organizationId: EntityId): Promise<Venue | null>;
  listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Venue>>;
  save(venue: Venue, tx?: TxContext | null): Promise<void>;
}

export interface SlotRequestRepository {
  getById(slotRequestId: EntityId): Promise<SlotRequest | null>;
  listByVenue(venueId: EntityId, query: PaginationQuery): Promise<Page<SlotRequest>>;
  save(request: SlotRequest, tx?: TxContext | null): Promise<void>;
}

export interface VenueSlotRepository {
  listSlots(venueId: EntityId, from: string, to: string): Promise<VenueSlot[]>;
  saveSlots(slots: VenueSlot[], tx?: TxContext | null): Promise<void>;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export interface EventRepository {
  getById(eventId: EntityId): Promise<Event | null>;
  listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Event>>;
  listByVenue(venueId: EntityId, query: PaginationQuery): Promise<Page<Event>>;
  listPublic(query: PaginationQuery): Promise<Page<Event>>;
  save(event: Event, tx?: TxContext | null): Promise<void>;
  delete(eventId: EntityId, tx?: TxContext | null): Promise<void>;
}

// ─── Event catalog (tiers / promos / tables / assignments) ───────────────────

export interface EventCatalogRepository {
  // Ticket tiers
  getTierById(tierId: EntityId): Promise<TicketTier | null>;
  listTiers(eventId: EntityId): Promise<TicketTier[]>;
  saveTier(tier: TicketTier, tx?: TxContext | null): Promise<void>;
  // Promo codes
  getPromoById(promoId: EntityId): Promise<PromoCode | null>;
  getPromoByCode(code: string, eventId: EntityId | null): Promise<PromoCode | null>;
  listPromos(eventId: EntityId, query: PaginationQuery): Promise<Page<PromoCode>>;
  savePromo(promo: PromoCode, tx?: TxContext | null): Promise<void>;
  // Table packages
  getTableById(tableId: EntityId): Promise<TablePackage | null>;
  listTables(eventId: EntityId): Promise<TablePackage[]>;
  saveTable(table: TablePackage, tx?: TxContext | null): Promise<void>;
  // Promoter assignments
  getAssignmentById(assignmentId: EntityId): Promise<PromoterAssignment | null>;
  listAssignments(eventId: EntityId): Promise<PromoterAssignment[]>;
  saveAssignment(assignment: PromoterAssignment, tx?: TxContext | null): Promise<void>;
}

// ─── Analytics read model ────────────────────────────────────────────────────
// Field names are the V1-proven dashboard contract (`analytics-engine.js` /
// `analytics.ts`): `totalTicketsSold`, `totalCheckIns`, `topEvents`,
// `ticketsSold`, `occupancyRate`, `sellThroughRate`, `noShowRate`, ... Money is
// paise in V2 (V1 emitted whole rupees — converted at the adapter boundary).

export interface TopEvent {
  eventId: EntityId;
  title: string;
  /** Paise (V1: whole rupees). */
  revenuePaise: number;
  tickets: number;
  /** ISO-8601 event date. */
  date: string;
}

export interface OrganizationOverview {
  organizationId: EntityId;
  totalEvents: number;
  /** Cached, precomputed at write time — never a per-request scan. */
  publishedEvents: number;
  totalRevenuePaise: number;
  totalTicketsSold: number;
  totalCheckIns: number;
  /** Top events by revenue (V1-proven `topEvents` shape). */
  topEvents: TopEvent[];
  /** `null` when the org has no finished events yet. */
  lastEventAt: string | null;
}

export interface EventAnalytics {
  eventId: EntityId;
  totalRevenuePaise: number;
  ticketsSold: number;
  totalCheckIns: number;
  /** Venue-reported capacity (V1 `capacity` on the analytics doc). */
  capacity: number;
  /** Event-page views (V1 `views`). */
  views: number;
  /** Guest-list signups (V1 `guestlistSignups`). */
  guestlistSignups: number;
  /** Paise (V1: whole rupees). */
  avgTicketPricePaise: number;
  /** Ratios 0..1, precomputed at write time (V1 computed same names). */
  occupancyRate: number;
  sellThroughRate: number;
  refundAmountPaise: number;
  refundRate: number;
  noShowRate: number;
  repeatGuests: number;
  conversionRate: number;
}

/** Read-model access. Writes happen through projections/workers, not routes. */
export interface AnalyticsReadModelRepository {
  getOrganizationOverview(organizationId: EntityId): Promise<OrganizationOverview | null>;
  getEventAnalytics(eventId: EntityId): Promise<EventAnalytics | null>;
}
