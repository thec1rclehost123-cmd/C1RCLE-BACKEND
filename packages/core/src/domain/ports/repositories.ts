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
import type { BankAccount } from '../models/bank-account.js';
import type { CartReservation } from '../models/cart-reservation.js';
import type {
  CoverWalletReconciliation,
  CoverWalletReconciliationCreateInput,
} from '../models/cover-wallet-reconciliation.js';
import type {
  CoverWallet,
  CoverWalletTxn,
  CoverWalletCreateInput,
  CoverWalletCreditInput,
  CoverWalletDebitInput,
  CoverWalletTxnType,
  CoverWalletTxnStatus,
} from '../models/cover-wallet.js';
import type { Dispute, DisputeStatus } from '../models/dispute.js';
import type {
  DoorSale,
  DoorSaleCreateInput,
  DoorSaleCategory,
  DoorSaleStatus,
} from '../models/door-sale.js';
import type { EmailOtp } from '../models/email-otp.js';
import type { AdmissionClaim, Entitlement } from '../models/entitlement.js';
import type {
  TicketTier,
  PromoCode,
  TablePackage,
  PromoterAssignment,
} from '../models/event-catalog.js';
import type {
  EventCode,
  EventCodeCreateInput,
  EventCodeStatus,
  ScannerSession,
  ScannerSessionCreateInput,
} from '../models/event-code.js';
import type { Event } from '../models/event.js';
import type { GuestProfile } from '../models/guest-profile.js';
import type {
  LeaderboardBucket,
  LeaderboardPeriodType,
  LeaderboardStat,
} from '../models/leaderboard.js';
import type { LedgerEntry, LedgerEntryType } from '../models/ledger.js';
import type { OnboardingRequest, OnboardingStatus } from '../models/onboarding.js';
import type { Order } from '../models/order.js';
import type {
  Organization,
  OrganizationInvitation,
  OrganizationMember,
} from '../models/organization.js';
import type { Partnership } from '../models/partnership.js';
import type { Payout, PayoutStatus } from '../models/payout.js';
import type { PlatformSettings } from '../models/platform-settings.js';
import type { PlatformUser } from '../models/platform-user.js';
import type { PromoterConnection } from '../models/promoter-connection.js';
import type { ReferralLink } from '../models/referral-link.js';
import type { AdminRefundRequest, AdminRefundRequestStatus } from '../models/refund-request.js';
import type {
  SafetyReport,
  SafetyReportCategory,
  SafetyReportPriority,
  SafetyReportStatus,
  SafetyReportTargetType,
} from '../models/safety-report.js';
import type {
  ScanLedger,
  ScanLedgerStatus,
  ScanLedgerCreateInput,
  ScanDenyReason,
} from '../models/scan-ledger.js';
import type { ScannerDevice } from '../models/scanner-device.js';
import type {
  SupportTicket,
  SupportTicketCategory,
  SupportTicketPriority,
  SupportTicketStatus,
} from '../models/support-ticket.js';
import type { UserBan } from '../models/user-ban.js';
import type { Venue, VenueSlot, SlotRequest } from '../models/venue.js';

// ─── Phase 5: Scan Ledger, Event Code, Scanner Session, Door Sale, Cover Wallet ───────

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
  /**
   * Batched id lookup. Replaces the per-row `getById` fan-out in list-style
   * reads (partnership/connection name resolution) so a 100-row page costs
   * one call, not 100. Missing ids are simply absent from the result: the
   * batched resolver's job is to resolve *names*, and a vanished row resolves
   * to `null`-safe fields, never an error.
   */
  getByIds(organizationIds: EntityId[]): Promise<Organization[]>;
  /** Public host-profile lookup — global (not org-scoped): a guest reaches an
   * organization by its slug alone, with no tenant context of their own. */
  getBySlug(slug: string): Promise<Organization | null>;
  /**
   * Bounded global browse of active organizations for partner discovery.
   * Returns at most `limit` rows in an unspecified order; kind/search
   * filtering happens in the discovery service so neither driver needs new
   * composite indexes.
   */
  listActive(limit: number): Promise<Organization[]>;
  /** All orgs a user id belongs to as a member. */
  listForMember(userId: EntityId, query: PaginationQuery): Promise<Page<Organization>>;
  /** Platform-wide org directory (admin hosts view) — global, not org-scoped. */
  listAll(query: PaginationQuery): Promise<Page<Organization>>;
  listMembers(organizationId: EntityId, query: PaginationQuery): Promise<Page<OrganizationMember>>;
  getMember(organizationId: EntityId, userId: EntityId): Promise<OrganizationMember | null>;
  save(org: Organization, tx?: TxContext | null): Promise<void>;
  delete(organizationId: EntityId, tx?: TxContext | null): Promise<void>;
}

/**
 * Platform user directory (admin users view). READ-ONLY by design — admin
 * routes never mutate Better Auth accounts. Implementations read the
 * `v2_auth_users` collection (firestore) or an in-memory seed (memory driver).
 */
export interface UserAccountRepository {
  /** Platform-wide user directory — global, not org-scoped. */
  listAll(query: PaginationQuery): Promise<Page<PlatformUser>>;
  getById(userId: EntityId): Promise<PlatformUser | null>;
  /** Exact-match lookup by email — the admin global-lookup's second key besides id. */
  getByEmail(email: string): Promise<PlatformUser | null>;
}

/** Ban state for platform users, one record per user, keyed by user id. */
export interface UserBanRepository {
  getByUserId(userId: EntityId): Promise<UserBan | null>;
  save(ban: UserBan, tx?: TxContext | null): Promise<void>;
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
  /**
   * Batched id lookup for list-style reads (partnership/connection name
   * resolution) — same one-call-per-page contract as
   * `OrganizationRepository.getByIds`.
   */
  getByIds(venueIds: EntityId[]): Promise<Venue[]>;
  getBySlug(slug: string, organizationId: EntityId): Promise<Venue | null>;
  /** Public venue-profile lookup — global (not org-scoped): the guest surface
   * addresses a venue by slug alone, with no tenant context of its own. */
  getBySlugGlobal(slug: string): Promise<Venue | null>;
  /**
   * Bounded global browse of active venues for partner discovery. Same
   * contract as `OrganizationRepository.listActive`: at most `limit` rows,
   * filtering in the service.
   */
  listActive(limit: number): Promise<Venue[]>;
  listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Venue>>;
  /** Platform-wide venue directory (admin venues view) — global, not org-scoped. */
  listAll(query: PaginationQuery): Promise<Page<Venue>>;
  save(venue: Venue, tx?: TxContext | null): Promise<void>;
}

export interface SlotRequestRepository {
  getById(slotRequestId: EntityId): Promise<SlotRequest | null>;
  listByVenue(venueId: EntityId, query: PaginationQuery): Promise<Page<SlotRequest>>;
  /** Outgoing (host-side) requests: everything submitted by this organization. */
  listByHost(hostId: EntityId, query: PaginationQuery): Promise<Page<SlotRequest>>;
  save(request: SlotRequest, tx?: TxContext | null): Promise<void>;
}

export interface VenueSlotRepository {
  listSlots(venueId: EntityId, from: string, to: string): Promise<VenueSlot[]>;
  saveSlots(slots: VenueSlot[], tx?: TxContext | null): Promise<void>;
  /** Single-slot read for unblock (ownership + status checks). Null when missing. */
  getSlotById(slotId: EntityId): Promise<VenueSlot | null>;
  /**
   * Every slot of the venue whose range touches `[startTime, endTime)` —
   * regardless of status (the caller ignores `cancelled` tombstones).
   * Filtered in application code after a single equality query, like
   * `listSlots`, so no composite Firestore index is required.
   */
  listOverlappingSlots(venueId: EntityId, startTime: string, endTime: string): Promise<VenueSlot[]>;
  /**
   * Atomic block creation (closes the read-check-write TOCTOU on the overlap
   * guard). The overlap check and the insert run inside one storage
   * transaction, so two concurrent block requests for the same minutes can't
   * both pass the guard. Throws the same `InvalidOperationError` as domain
   * `assertSlotRangeFree` when the range is taken; returns the stored slot on
   * success. The memory driver performs the check synchronously (no `await`
   * between guard and write), which is atomic within a single event-loop turn.
   */
  createBlockIfFree(block: VenueSlot): Promise<VenueSlot>;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export interface EventRepository {
  getById(eventId: EntityId): Promise<Event | null>;
  findById(eventId: EntityId): Promise<Event | null>;
  /** Public detail lookup by slug — global (not org-scoped): the guest
   * `idOrSlug` route falls back to this when the path segment isn't a known id. */
  getBySlug(slug: string): Promise<Event | null>;
  listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Event>>;
  listByVenue(venueId: EntityId, query: PaginationQuery): Promise<Page<Event>>;
  /** Platform-wide event directory (admin events view) — global, includes non-public. */
  listAll(query: PaginationQuery): Promise<Page<Event>>;
  listPublic(query: PaginationQuery): Promise<Page<Event>>;
  save(event: Event, tx?: TxContext | null): Promise<void>;
  delete(eventId: EntityId, tx?: TxContext | null): Promise<void>;
}

// ─── Event catalog (tiers / promos / tables / assignments) ───────────────────

export interface EventCatalogRepository {
  // Ticket tiers
  getTierById(tierId: EntityId): Promise<TicketTier | null>;
  listTiers(eventId: EntityId): Promise<TicketTier[]>;
  findWalkInTier(eventId: EntityId): Promise<TicketTier | null>;
  findDineInTier(eventId: EntityId): Promise<TicketTier | null>;
  saveTier(tier: TicketTier, tx?: TxContext | null): Promise<void>;
  // Promo codes
  getPromoById(promoId: EntityId): Promise<PromoCode | null>;
  getPromoByCode(code: string, eventId: EntityId | null): Promise<PromoCode | null>;
  listPromos(eventId: EntityId, query: PaginationQuery): Promise<Page<PromoCode>>;
  /** Platform-wide promo listing (admin read-only dashboard). */
  listAllPromos(query: PaginationQuery): Promise<Page<PromoCode>>;
  savePromo(promo: PromoCode, tx?: TxContext | null): Promise<void>;
  // Table packages
  getTableById(tableId: EntityId): Promise<TablePackage | null>;
  listTables(eventId: EntityId): Promise<TablePackage[]>;
  saveTable(table: TablePackage, tx?: TxContext | null): Promise<void>;
  // Promoter assignments
  getAssignmentById(assignmentId: EntityId): Promise<PromoterAssignment | null>;
  listAssignments(eventId: EntityId): Promise<PromoterAssignment[]>;
  /** All assignments for a given promoter user (admin lifecycle queries). */
  listAssignmentsByPromoter(promoterId: EntityId): Promise<PromoterAssignment[]>;
  /** Platform-wide promoter-assignment listing (admin read-only dashboard). */
  listAllAssignments(query: PaginationQuery): Promise<Page<PromoterAssignment>>;
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
  /**
   * The approved request that provisioned this organization — the only
   * record of its plan tier (Phase 6: `platformFeePercentFor`). At most one
   * approved request can carry a given `provisionedOrganizationId`.
   */
  findByProvisionedOrganizationId(organizationId: EntityId): Promise<OnboardingRequest | null>;
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

// ─── Phase 4: Order, Cart Reservation, Entitlement, Promo Redemption ───────────

/** Standard paginated read outcome. `nextCursor` is null when exhausted. */
export interface Page<TItem> {
  items: TItem[];
  /** True total before paging (V1-proven `total`; 0 when the source lacks a count). */
  total: number;
  nextCursor: string | null;
}

export interface PaginationQuery {
  cursor?: string | null;
  limit: number;
}

/** Transaction/atomicity handle. Storage-agnostic. Routes pass `null`. */
export interface TxContext {
  readonly kind: 'tx';
  readonly id: string;
}

/** Cart reservation (hold) — short-lived inventory lock before payment. */
export interface CartReservationRepository {
  /** Creates a new hold. Fails if inventory is not available. */
  create(reservation: CartReservation, tx?: TxContext | null): Promise<void>;
  /** Fetches by id. */
  getById(reservationId: EntityId): Promise<CartReservation | null>;
  /** Fetches by idempotency key (for idempotent hold creation). */
  getByIdempotencyKey(key: string): Promise<CartReservation | null>;
  /** Releases the hold (marks as released/expired). */
  release(reservationId: EntityId, tx?: TxContext | null): Promise<void>;
  /** Converts a hold to an order (atomic with order creation). */
  convertToOrder(reservationId: EntityId, orderId: EntityId, tx?: TxContext | null): Promise<void>;
  /** Cleans up expired holds (called by a worker). */
  cleanupExpired(now: Date, tx?: TxContext | null): Promise<number>;
  /**
   * All holds for an event still holding inventory — `status: 'active'` AND
   * not yet past `expiresAt`. Unpaginated: a live hold set is bounded by the
   * ~10-minute TTL, unlike historical orders. Internal aggregation input for
   * `InventoryService.getAvailableQuantity` — never a public route response.
   */
  listActiveByEvent(eventId: EntityId, now: Date): Promise<CartReservation[]>;
  /**
   * Sum of `quantity` across a user's live holds for `(tierId, eventId)` —
   * `status: 'active'` and not yet past `now`. Drives per-user ticket-caps
   * (`tier.maxPerUser`) at hold creation. Bounded by one user's active cart
   * holdings; never a public route response.
   */
  countActiveQuantity(
    userId: EntityId,
    eventId: EntityId,
    tierId: EntityId,
    now: Date,
  ): Promise<number>;
}

/** Order repository — the commerce aggregate. */
export interface OrderRepository {
  /** Fetches by id. */
  getById(orderId: EntityId): Promise<Order | null>;
  /** Fetches by payment id (idempotency anchor for dual confirmation). */
  getByPaymentId(paymentId: string): Promise<Order | null>;
  /** Fetches by idempotency key (for idempotent order creation). */
  getByIdempotencyKey(key: string): Promise<Order | null>;
  /** Lists orders for a user (wallet). */
  listByUser(userId: EntityId, query: PaginationQuery): Promise<Page<Order>>;
  /** Lists orders for an organization (partner/admin dashboard). */
  listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Order>>;
  /** Lists orders for an event. */
  listByEvent(eventId: EntityId, query: PaginationQuery): Promise<Page<Order>>;
  /**
   * Sum of `quantity` across a user's *paid* orders for `(tierId, eventId)`.
   * Drives per-user ticket-caps (`tier.maxPerUser`) at hold creation: only
   * money- captured orders count — `pending`/`failed`/`cancelled`/`refunded`
   * never consume the cap. Bounded by one user's order history; never a
   * public route response.
   */
  countPaidQuantityByUserAndEvent(
    userId: EntityId,
    eventId: EntityId,
    tierId: EntityId,
  ): Promise<number>;
  /** Lists all orders platform-wide (admin read-only dashboards). */
  listAll(query: PaginationQuery): Promise<Page<Order>>;
  /** Saves (create or update). Version is checked for optimistic locking. */
  save(order: Order, tx?: TxContext | null): Promise<void>;
}

/** Entitlement repository — the ticket/wallet aggregate. */
export interface EntitlementRepository {
  /** Fetches by deterministic id (`ENT-{orderId}-{tierId}-{index}`). */
  getById(entitlementId: EntityId): Promise<Entitlement | null>;
  /** Alias for getById. */
  findById(entitlementId: EntityId): Promise<Entitlement | null>;
  /** Fetches all entitlements for an order (fulfilment verification). */
  getByOrderId(orderId: EntityId): Promise<Entitlement[]>;
  /** Fetches entitlements for a user (wallet). */
  listByUser(userId: EntityId, query: PaginationQuery): Promise<Page<Entitlement>>;
  /** Fetches entitlements for an event (door operations). */
  listByEvent(eventId: EntityId, query: PaginationQuery): Promise<Page<Entitlement>>;
  /** Fetches entitlements for an organization (partner/admin). */
  listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Entitlement>>;
  /** Lists all entitlements platform-wide (admin read-only dashboards). */
  listAll(query: PaginationQuery): Promise<Page<Entitlement>>;
  /** Saves (create or update — scan increments version). Version checked for optimistic locking. */
  save(entitlement: Entitlement, tx?: TxContext | null): Promise<void>;
  /** Bulk save for fulfilment (atomic with order creation). */
  saveMany(entitlements: Entitlement[], tx?: TxContext | null): Promise<void>;
  /** Counts valid entitlements for a tier (inventory/sell-through). */
  countValidByTier(tierId: EntityId): Promise<number>;
  /**
   * Atomically admits one person against this entitlement, or refuses.
   *
   * This is the door's ONLY admission primitive. Two physical scanners can
   * present the same QR in the same millisecond; a read-then-write in a
   * service would let both through (both read `scanCount: 0`, both write
   * `1`). The check and the increment therefore happen where atomicity
   * actually exists — inside the adapter, in one Firestore transaction
   * (D-015's rule, applied to admission rather than to `version`).
   *
   * The rule itself is not duplicated here: both adapters call the domain's
   * `admitSeats`, so the transactional path and the read-only preview path
   * can never disagree about what is admissible.
   */
  claimAdmission(
    entitlementId: EntityId,
    eventId: EntityId,
    options?: ClaimAdmissionOptions,
  ): Promise<AdmissionClaim>;
}

export type { AdmissionClaim };

export interface ClaimAdmissionOptions {
  /**
   * How many people this one call admits. 1 for an ordinary scan; 2 for a
   * confirmed couple ticket, where both guests walk through together and the
   * pair must be consumed in ONE transaction — claiming twice would let the
   * two halves land either side of a concurrent scan and admit three people
   * on a two-person ticket. Defaults to 1.
   */
  seats?: number;
  /**
   * Refuses the claim unless the ticket's scan count is exactly this. The
   * couple-confirmation token was minted against a state a staff member saw;
   * if anything consumed a seat since, the confirmation must fail rather than
   * admit against a target that moved underneath it.
   */
  expectedScansUsed?: number;
  now?: Date;
}

/** Promo redemption tracking (shared with Phase 3 event-catalog). */
export interface PromoRedemptionRepository {
  /** Records a redemption. Fails if duplicate for same order. */
  create(
    redemption: {
      id: EntityId;
      promoId: EntityId;
      orderId: EntityId;
      userId: EntityId | null;
      redeemedAt: string;
    },
    tx?: TxContext | null,
  ): Promise<void>;
  /** Fetches by order id (for audit). */
  getByOrderId(orderId: EntityId): Promise<{ promoId: EntityId; redeemedAt: string } | null>;
  /** Counts redemptions for a promo (enforces maxRedemptions). */
  countByPromo(promoId: EntityId): Promise<number>;
  /** Counts redemptions by a user for a promo (enforces maxPerUser). */
  countByPromoAndUser(promoId: EntityId, userId: EntityId): Promise<number>;
}

/** Scan Ledger repository — immutable scan records. */
export interface ScanLedgerRepository {
  create(input: ScanLedgerCreateInput): Promise<ScanLedger>;
  findById(id: EntityId): Promise<ScanLedger | null>;
  findByEventAndEntitlement(eventId: EntityId, entitlementId: EntityId): Promise<ScanLedger | null>;
  findByEvent(eventId: EntityId, input: PaginationQuery): Promise<Page<ScanLedger>>;
  findByOrganization(organizationId: EntityId, input: PaginationQuery): Promise<Page<ScanLedger>>;
  findByDevice(deviceId: string, input: PaginationQuery): Promise<Page<ScanLedger>>;
  findByOperator(operatorUid: string, input: PaginationQuery): Promise<Page<ScanLedger>>;
  updateStatus(
    id: EntityId,
    status: ScanLedgerStatus,
    denyReason?: ScanDenyReason,
    denyMessage?: string,
  ): Promise<ScanLedger | null>;
  markConsumed(id: EntityId): Promise<ScanLedger | null>;
  markDenied(id: EntityId, reason: ScanDenyReason, message: string): Promise<ScanLedger | null>;
  markCancelled(id: EntityId): Promise<ScanLedger | null>;
  /** Legal only from `denied` — see `domain/models/scan-ledger.ts`'s `overrideScan`. */
  markOverridden(id: EntityId, overriddenBy: string, reason: string): Promise<ScanLedger | null>;
  countByEventAndStatus(eventId: EntityId, status: ScanLedgerStatus): Promise<number>;
  /**
   * People actually admitted for an event, and how they came in.
   *
   * A count of rows is NOT this number: one confirmed couple-ticket row
   * admits two, an override row admits one against a denial, and a denied row
   * admits nobody. The door's occupancy gauge is a life-safety number, so it
   * sums `admittedCount` rather than counting scans.
   */
  getAdmissionStats(eventId: EntityId, tierNames: readonly string[]): Promise<ScanAdmissionStats>;
  countConsumedByEntitlement(entitlementId: EntityId): Promise<number>;
  /**
   * Offline backlog for an event's sync replay (scans recorded before `before`).
   * Bounded: returns at most `MAX_SYNC_SCANS` rows, no ordering promise — a
   * backlog larger than that needs another sync pass once the queue drains, so
   * callers must loop rather than assume they got everything.
   */
  findOfflineScans(eventId: EntityId, before: Date): Promise<ScanLedger[]>;
}

export interface ScanAdmissionStats {
  /** Total people admitted by ticket scans (couples counted as two). */
  admitted: number;
  /** Admitted per tier name, for the tier names asked for. */
  byEntryType: Record<string, number>;
  /**
   * Admitted against a tier that no longer appears in the event's catalog
   * (renamed or deleted mid-event). Surfaced rather than dropped so the parts
   * always add up to `admitted` — a breakdown that silently loses people is
   * worse than one that says "and these".
   */
  unattributed: number;
}

/**
 * Bound scanner devices — the handsets a venue has authorized for its door.
 * Keyed by `${organizationId}_${deviceId}` so a device id only ever means
 * something inside one tenant.
 */
export interface ScannerDeviceRepository {
  findById(id: EntityId): Promise<ScannerDevice | null>;
  findByDevice(organizationId: EntityId, deviceId: string): Promise<ScannerDevice | null>;
  listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<ScannerDevice>>;
  save(device: ScannerDevice, tx?: TxContext | null): Promise<void>;
  /**
   * Liveness + per-device counters. Deliberately NOT a `save` of the whole
   * aggregate: heartbeats and scan counters arrive constantly and from every
   * device at once, and routing them through the version check would make
   * ordinary traffic conflict with itself. Nothing here is an invariant —
   * these fields are observability, not truth.
   */
  touch(
    id: EntityId,
    patch: {
      lastSeenAt: string;
      lastEventId?: EntityId | null;
      lastGate?: string | null;
      lastScanAt?: string | null;
      lastScanResult?: string | null;
      incrementScanCount?: boolean;
    },
  ): Promise<void>;
}

/** Event Code repository — authorization codes for scanner apps. */
export interface EventCodeRepository {
  create(input: EventCodeCreateInput): Promise<EventCode>;
  findById(id: EntityId): Promise<EventCode | null>;
  findByCode(code: string): Promise<EventCode | null>;
  findByEvent(eventId: EntityId, input: PaginationQuery): Promise<Page<EventCode>>;
  findByOrganization(organizationId: EntityId, input: PaginationQuery): Promise<Page<EventCode>>;
  findActiveByEvent(eventId: EntityId): Promise<EventCode[]>;
  updateStatus(
    id: EntityId,
    status: EventCodeStatus,
    revokedReason?: string,
  ): Promise<EventCode | null>;
  revoke(id: EntityId, reason: string): Promise<EventCode | null>;
  incrementScanCount(id: EntityId): Promise<void>;
  incrementDoorEntry(id: EntityId, amountPaise: number): Promise<void>;
  updateLastUsed(id: EntityId): Promise<void>;
  adjustActiveSessions(id: EntityId, delta: number): Promise<void>;
}

/** Scanner Session repository — short-lived device tokens. */
export interface ScannerSessionRepository {
  create(input: ScannerSessionCreateInput): Promise<{
    session: ScannerSession;
    sessionToken: string;
    sessionExpiresAt: string;
    sessionId: string;
  }>;
  findById(id: EntityId): Promise<ScannerSession | null>;
  findByTokenHash(tokenHash: string): Promise<ScannerSession | null>;
  findByCode(codeId: EntityId, input: PaginationQuery): Promise<Page<ScannerSession>>;
  findActiveByCode(codeId: EntityId): Promise<ScannerSession[]>;
  findByDevice(deviceId: string, input: PaginationQuery): Promise<Page<ScannerSession>>;
  updateLastUsed(id: EntityId): Promise<void>;
  revoke(id: EntityId, reason: string): Promise<ScannerSession | null>;
  cleanupExpired(): Promise<number>;
}

/** Door Sale repository — walk-in and dine-in sales. */
export interface DoorSaleRepository {
  create(input: DoorSaleCreateInput): Promise<DoorSale>;
  findById(id: EntityId): Promise<DoorSale | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<DoorSale | null>;
  findByEvent(eventId: EntityId, input: PaginationQuery): Promise<Page<DoorSale>>;
  findByOrganization(organizationId: EntityId, input: PaginationQuery): Promise<Page<DoorSale>>;
  findByVenue(venueId: EntityId, input: PaginationQuery): Promise<Page<DoorSale>>;
  findByCategory(category: DoorSaleCategory, input: PaginationQuery): Promise<Page<DoorSale>>;
  findByCreator(createdBy: EntityId, input: PaginationQuery): Promise<Page<DoorSale>>;
  updateStatus(id: EntityId, status: DoorSaleStatus): Promise<DoorSale | null>;
  voidSale(id: EntityId, voidedBy: EntityId, reason: string): Promise<DoorSale | null>;
  refundSale(id: EntityId, refundedBy: EntityId, amountPaise: number): Promise<DoorSale | null>;
  getEventStats(eventId: EntityId): Promise<{
    totalSales: number;
    totalRevenue: number;
    walkinCount: number;
    dineinCount: number;
    walkinRevenue: number;
    dineinRevenue: number;
    byPaymentMode: Record<string, { count: number; revenue: number }>;
  }>;
  getOrganizationStats(
    organizationId: EntityId,
    from: Date,
    to: Date,
  ): Promise<{
    totalSales: number;
    totalRevenue: number;
    byCategory: Record<string, { count: number; revenue: number }>;
    byPaymentMode: Record<string, { count: number; revenue: number }>;
  }>;
}

/** Cover Wallet repository — pre-paid wallets for venue entry. */
export interface CoverWalletRepository {
  create(input: CoverWalletCreateInput): Promise<CoverWallet>;
  findById(id: EntityId): Promise<CoverWallet | null>;
  findByEventAndUser(eventId: EntityId, userId: EntityId): Promise<CoverWallet | null>;
  findByEvent(eventId: EntityId, input: PaginationQuery): Promise<Page<CoverWallet>>;
  findByOrganization(organizationId: EntityId, input: PaginationQuery): Promise<Page<CoverWallet>>;
  findActiveByEvent(eventId: EntityId): Promise<CoverWallet[]>;
  credit(input: CoverWalletCreditInput): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }>;
  debit(input: CoverWalletDebitInput): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }>;
  refund(
    walletId: EntityId,
    amount: number,
    referenceId: EntityId,
    idempotencyKey: string,
    operatorUid: EntityId,
    description: string,
  ): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }>;
  adjust(
    walletId: EntityId,
    amount: number,
    idempotencyKey: string,
    operatorUid: EntityId,
    description: string,
  ): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }>;
  terminate(walletId: EntityId, reason: string): Promise<CoverWallet | null>;
  close(walletId: EntityId): Promise<CoverWallet | null>;
  /** Legal only from `active`. Reversible — unlike `terminate`/`close`, no balance change. */
  freeze(walletId: EntityId): Promise<CoverWallet | null>;
  /** Legal only from `frozen`. */
  unfreeze(walletId: EntityId): Promise<CoverWallet | null>;
  getBalance(walletId: EntityId): Promise<number | null>;
  isActive(walletId: EntityId): Promise<boolean>;
  countRecentDebits(deviceId: string, since: Date): Promise<number>;
  getEventStats(eventId: EntityId): Promise<{
    totalWallets: number;
    activeWallets: number;
    terminatedWallets: number;
    totalBalance: number;
    totalCredits: number;
    totalDebits: number;
    totalRefunds: number;
    avgBalance: number;
    byStatus: Record<string, number>;
  }>;
}

/** Cover Wallet Transaction repository. */
export interface CoverWalletTxnRepository {
  create(
    txn: Omit<CoverWalletTxn, 'id' | 'createdAt' | 'updatedAt' | 'version'>,
  ): Promise<CoverWalletTxn>;
  findById(id: EntityId): Promise<CoverWalletTxn | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<CoverWalletTxn | null>;
  findByWallet(walletId: EntityId, input: PaginationQuery): Promise<Page<CoverWalletTxn>>;
  findByEvent(eventId: EntityId, input: PaginationQuery): Promise<Page<CoverWalletTxn>>;
  findByType(type: CoverWalletTxnType, input: PaginationQuery): Promise<Page<CoverWalletTxn>>;
  findByReference(referenceId: EntityId, referenceType: string): Promise<CoverWalletTxn[]>;
  updateStatus(
    id: EntityId,
    status: CoverWalletTxnStatus,
    failureReason?: string,
    processedAt?: Date,
  ): Promise<CoverWalletTxn | null>;
  getEventStats(eventId: EntityId): Promise<{
    totalCredits: number;
    totalDebits: number;
    totalRefunds: number;
    totalAdjustments: number;
    netFlow: number;
    txnCount: number;
  }>;
  countRecentDebits(deviceId: string, since: Date): Promise<number>;
}

/** Cover Wallet Reconciliation repository. */
export interface CoverWalletReconciliationRepository {
  create(input: CoverWalletReconciliationCreateInput): Promise<CoverWalletReconciliation>;
  findById(id: EntityId): Promise<CoverWalletReconciliation | null>;
  findByEventAndDate(eventId: EntityId, date: string): Promise<CoverWalletReconciliation | null>;
  findByEvent(eventId: EntityId, input: PaginationQuery): Promise<Page<CoverWalletReconciliation>>;
  findByOrganization(
    organizationId: EntityId,
    input: PaginationQuery,
  ): Promise<Page<CoverWalletReconciliation>>;
  findPending(organizationId: EntityId): Promise<CoverWalletReconciliation[]>;
  findWithDiscrepancies(organizationId: EntityId): Promise<CoverWalletReconciliation[]>;
  resolve(
    id: EntityId,
    resolvedBy: EntityId,
    notes: string,
  ): Promise<CoverWalletReconciliation | null>;
  getOrganizationStats(
    organizationId: EntityId,
    from: Date,
    to: Date,
  ): Promise<{
    totalReconciliations: number;
    completedCount: number;
    discrepancyCount: number;
    resolvedCount: number;
    totalDiscrepancyAmount: number;
  }>;
}

// ─── Phase 6: Ledger, Payout, Bank Account ────────────────────────────────────

/** Append-only settlement ledger — the sole source of truth for balances. */
export interface LedgerRepository {
  /** Idempotent: returns the existing entries if `orderId` was already recorded for this entryType set. */
  createBatch(entries: LedgerEntry[]): Promise<LedgerEntry[]>;
  findByOrder(orderId: EntityId): Promise<LedgerEntry[]>;
  findByIdempotencyKey(idempotencyKey: string): Promise<LedgerEntry | null>;
  listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<LedgerEntry>>;
  /** Full recompute from every entry — used when the aggregate cache is missing/stale. */
  sumByOrganizationAndType(
    organizationId: EntityId,
  ): Promise<Record<LedgerEntryType, { pending: number; settled: number; paidOut: number }>>;
}

/** Payout requests — draw-downs against the ledger-computed available balance. */
export interface PayoutRepository {
  create(payout: Payout): Promise<Payout>;
  findById(id: EntityId): Promise<Payout | null>;
  save(payout: Payout): Promise<Payout>;
  listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Payout>>;
  sumPaidByOrganization(organizationId: EntityId): Promise<number>;
  sumRequestedOrProcessingByOrganization(organizationId: EntityId): Promise<number>;
  /** Cross-org admin view — the batch-run and freeze/release queues. `null` = every status. */
  listByStatus(status: PayoutStatus | null, query: PaginationQuery): Promise<Page<Payout>>;
}

/** Partner payout destinations. Full account number never leaves the adapter unmasked. */
export interface BankAccountRepository {
  create(account: BankAccount): Promise<BankAccount>;
  findById(id: EntityId): Promise<BankAccount | null>;
  listByOrganization(organizationId: EntityId): Promise<BankAccount[]>;
  findDefaultByOrganization(organizationId: EntityId): Promise<BankAccount | null>;
  save(account: BankAccount): Promise<BankAccount>;
  delete(id: EntityId): Promise<void>;
}

/** Partner challenges against a ledger entry or payout amount. */
export interface DisputeRepository {
  create(dispute: Dispute): Promise<Dispute>;
  findById(id: EntityId): Promise<Dispute | null>;
  save(dispute: Dispute): Promise<Dispute>;
  listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery & { status?: DisputeStatus },
  ): Promise<Page<Dispute>>;
  /** Cross-org admin queue. `null` = every status. */
  listByStatus(status: DisputeStatus | null, query: PaginationQuery): Promise<Page<Dispute>>;
}

/** Admin refund requests (Phase 6 admin). Version-checked saves for the N-approver accumulator. */
export interface AdminRefundRequestRepository {
  getById(id: EntityId): Promise<AdminRefundRequest | null>;
  /** Every request against one order — used to compute the refundable remainder. */
  listByOrder(orderId: EntityId): Promise<AdminRefundRequest[]>;
  listByStatus(
    status: AdminRefundRequestStatus | null,
    query: PaginationQuery,
  ): Promise<Page<AdminRefundRequest>>;
  save(request: AdminRefundRequest, tx?: TxContext | null): Promise<void>;
}

/**
 * Platform safety reports (Phase 7). Version-checked saves — the report is a
 * single versioned aggregate, so a concurrent resolution write loses. Soft
 * deletion follows the same "always recoverable" rule as support tickets.
 */
export interface SafetyReportQuery {
  status?: SafetyReportStatus;
  category?: SafetyReportCategory;
  priority?: SafetyReportPriority;
  targetType?: SafetyReportTargetType;
  reporterUserId?: EntityId;
  /** Case-insensitive substring over details. */
  search?: string;
  includeDeleted?: boolean;
}

/** Desk stat counters — the real safety metric (no v1-style fabricated rating). */
export interface SafetyReportStats {
  open: number;
  dismissed: number;
  actioned: number;
  total: number;
  /** All reports in the critical bucket (category `safety`). */
  critical: number;
}

export interface SafetyReportRepository {
  getById(id: EntityId, opts?: { includeDeleted?: boolean }): Promise<SafetyReport | null>;
  list(query: SafetyReportQuery, pagination: PaginationQuery): Promise<Page<SafetyReport>>;
  listByReporter(
    reporterUserId: EntityId,
    pagination: PaginationQuery,
  ): Promise<Page<SafetyReport>>;
  stats(): Promise<SafetyReportStats>;
  save(report: SafetyReport): Promise<void>;
}

/**
 * Platform support tickets (Phase 7). Version-checked saves — the ticket is a
 * single versioned aggregate (messages, internal notes and timeline live on
 * it), so every mutation bumps `version` and a concurrent write loses.
 * `softDeleted` tickets are never returned by `list` unless explicitly
 * requested, matching the "soft delete with attribution, always recoverable"
 * rule; they remain addressable by `getById` so restore is a pure save.
 */
export interface SupportTicketQuery {
  status?: SupportTicketStatus;
  priority?: SupportTicketPriority;
  category?: SupportTicketCategory;
  assigneeUserId?: EntityId;
  requesterUserId?: EntityId;
  /** Case-insensitive substring over subject + description. */
  search?: string;
  includeDeleted?: boolean;
}

export interface SupportTicketRepository {
  getById(id: EntityId, opts?: { includeDeleted?: boolean }): Promise<SupportTicket | null>;
  /** The ticket a client points at via `mergedInto`. */
  listByMergedInto(ticketId: EntityId): Promise<SupportTicket[]>;
  list(query: SupportTicketQuery, pagination: PaginationQuery): Promise<Page<SupportTicket>>;
  listByRequester(
    requesterUserId: EntityId,
    pagination: PaginationQuery,
  ): Promise<Page<SupportTicket>>;
  save(ticket: SupportTicket): Promise<void>;
}

/**
 * Promoter leaderboard read-model — a fixed set of buckets incremented on
 * every commission-earning ticket sale, never a versioned aggregate (no
 * `save`/optimistic-lock: concurrent increments to the same bucket are
 * commutative, so the adapter applies them additively instead).
 */
export interface LeaderboardRepository {
  /** Applies one commission amount to every bucket in `buckets`, additively. */
  incrementMany(
    promoterId: EntityId,
    buckets: LeaderboardBucket[],
    amountPaise: number,
    now: string,
  ): Promise<void>;
  getForPromoter(promoterId: EntityId, bucket: LeaderboardBucket): Promise<LeaderboardStat | null>;
  top(
    periodType: LeaderboardPeriodType,
    periodValue: string,
    city: string,
    limit: number,
  ): Promise<LeaderboardStat[]>;
}

/**
 * One doc per recipient, fully replaced on each send — no optimistic-lock
 * version (matches v1's `docRef.set` semantics; the cooldown check in
 * `assertCanResend` is what prevents a resend race, not a version field).
 */
export interface EmailOtpRepository {
  get(recipient: EntityId): Promise<EmailOtp | null>;
  save(otp: EmailOtp): Promise<void>;
  delete(recipient: EntityId): Promise<void>;
}

/**
 * One doc per session user id, fully replaced on each save — no
 * optimistic-lock version (matches `EmailOtpRepository`'s `docRef.set`
 * semantics; a `PUT` with the same body converges, so retries are safe).
 */
export interface GuestProfileRepository {
  getByUserId(userId: EntityId): Promise<GuestProfile | null>;
  save(profile: GuestProfile): Promise<void>;
}
// ─── Platform settings (singleton doc) ──────────────────────────────────────

/**
 * Singleton read/write for the platform-wide settings doc.
 * Backed by `v2_platform_settings/singleton` in Firestore.
 */
export interface PlatformSettingsRepository {
  get(): Promise<PlatformSettings>;
  save(settings: PlatformSettings): Promise<void>;
}

export type {
  LedgerEntry,
  LedgerEntryType,
  Payout,
  PayoutStatus,
  BankAccount,
  Dispute,
  DisputeStatus,
  LeaderboardStat,
  LeaderboardBucket,
  LeaderboardPeriodType,
  EmailOtp,
  GuestProfile,
  PlatformSettings,
};
