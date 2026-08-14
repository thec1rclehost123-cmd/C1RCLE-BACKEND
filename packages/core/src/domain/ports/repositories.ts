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
import type { PlatformAdmin, ProposalStatus, ProposedAction } from '../models/admin-authority.js';
import type {
  TicketTier,
  PromoCode,
  TablePackage,
  PromoterAssignment,
} from '../models/event-catalog.js';
import type { Event } from '../models/event.js';
import type { OnboardingRequest, OnboardingStatus } from '../models/onboarding.js';
import type {
  Organization,
  OrganizationInvitation,
  OrganizationMember,
} from '../models/organization.js';
import type { Partnership } from '../models/partnership.js';
import type { PromoterConnection } from '../models/promoter-connection.js';
import type { ReferralLink } from '../models/referral-link.js';
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

/**
 * Pending invitations live beside the organization rather than inside it: they
 * are addressed by email (the invitee may have no account yet) and they
 * outlive nothing — an accepted one stays as the audit trail of how a member
 * joined.
 */
/**
 * The venue↔host graph. Addressed by pair as well as by id, because the
 * "one live partnership per pair" rule needs a lookup that does not depend on
 * the caller already knowing the partnership id.
 */
export interface PartnershipRepository {
  getById(partnershipId: EntityId): Promise<Partnership | null>;
  findByPair(hostOrganizationId: EntityId, venueId: EntityId): Promise<Partnership | null>;
  /** Every partnership either side of which is this organization. */
  listForOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Partnership>>;
  save(partnership: Partnership, tx?: TxContext | null): Promise<void>;
}

/**
 * Referral links are looked up by CODE on the guest path (a click) and by
 * event on the partner path (a dashboard list), so both are first-class.
 */
export interface ReferralLinkRepository {
  getById(linkId: EntityId): Promise<ReferralLink | null>;
  /** The guest-facing lookup: resolve a shared code to its link. */
  findByCode(eventId: EntityId, code: string): Promise<ReferralLink | null>;
  listByEvent(eventId: EntityId, query: PaginationQuery): Promise<Page<ReferralLink>>;
  listByPromoter(promoterId: EntityId, query: PaginationQuery): Promise<Page<ReferralLink>>;
  save(link: ReferralLink, tx?: TxContext | null): Promise<void>;
}

/** The promoter↔host/venue graph, addressed by pair and by either side. */
export interface PromoterConnectionRepository {
  getById(connectionId: EntityId): Promise<PromoterConnection | null>;
  findByPair(promoterId: EntityId, targetId: EntityId): Promise<PromoterConnection | null>;
  listForOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<PromoterConnection>>;
  save(connection: PromoterConnection, tx?: TxContext | null): Promise<void>;
}

export interface InvitationRepository {
  getById(invitationId: EntityId): Promise<OrganizationInvitation | null>;
  listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<OrganizationInvitation>>;
  /** Used to refuse a second pending invitation for the same address. */
  findPendingByEmail(
    organizationId: EntityId,
    email: string,
  ): Promise<OrganizationInvitation | null>;
  save(invitation: OrganizationInvitation, tx?: TxContext | null): Promise<void>;
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

// ─── Onboarding / KYC (Phase 2) ──────────────────────────────────────────────

/**
 * Onboarding requests are keyed by the applicant's *user* id, not by an
 * organization: the whole point of the flow is that the applicant has no
 * organization yet. `findOpenForUser` exists so "one live application per
 * person" can be enforced without the caller already knowing the request id.
 */
export interface OnboardingRepository {
  getById(requestId: EntityId): Promise<OnboardingRequest | null>;
  /** The applicant's request that is still in play (draft/submitted/changes). */
  findOpenForUser(userId: EntityId): Promise<OnboardingRequest | null>;
  listForUser(userId: EntityId, query: PaginationQuery): Promise<Page<OnboardingRequest>>;
  /** The admin review queue. `status: null` lists every request. */
  listByStatus(
    status: OnboardingStatus | null,
    query: PaginationQuery,
  ): Promise<Page<OnboardingRequest>>;
  save(request: OnboardingRequest, tx?: TxContext | null): Promise<void>;
}

/** Platform operators, keyed by auth user id. */
export interface PlatformAdminRepository {
  getById(userId: EntityId): Promise<PlatformAdmin | null>;
  list(query: PaginationQuery): Promise<Page<PlatformAdmin>>;
  save(admin: PlatformAdmin, tx?: TxContext | null): Promise<void>;
}

/** TIER3 dual-control proposals awaiting a second admin. */
export interface ProposedActionRepository {
  getById(proposalId: EntityId): Promise<ProposedAction | null>;
  listByStatus(
    status: ProposalStatus | null,
    query: PaginationQuery,
  ): Promise<Page<ProposedAction>>;
  save(proposal: ProposedAction, tx?: TxContext | null): Promise<void>;
}

/**
 * One recorded KYC verification attempt. Mirrors v1's
 * `verificationAttempts/{userId}/attempts/{id}`, which existed to bound how
 * many times an applicant may probe a document check.
 */
export interface VerificationAttempt {
  id: EntityId;
  userId: EntityId;
  /** Which document kind was checked, e.g. `aadhaar`, `pan`. */
  documentType: string;
  outcome: 'passed' | 'failed' | 'error';
  /** Provider name, so a later provider swap is visible in the history. */
  provider: string;
  /** Epoch ms. */
  attemptedAt: number;
}

export interface VerificationAttemptRepository {
  append(attempt: VerificationAttempt): Promise<void>;
  /** Attempts by this user since `sinceEpochMs` — the rate-limit input. */
  countSince(userId: EntityId, sinceEpochMs: number): Promise<number>;
  listForUser(userId: EntityId, limit: number): Promise<VerificationAttempt[]>;
}
