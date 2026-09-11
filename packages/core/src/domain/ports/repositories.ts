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
import type { Entitlement } from '../models/entitlement.js';
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
import type { PlatformUser } from '../models/platform-user.js';
import type { PromoterConnection } from '../models/promoter-connection.js';
import type { ReferralLink } from '../models/referral-link.js';
import type { AdminRefundRequest, AdminRefundRequestStatus } from '../models/refund-request.js';
import type {
  ScanLedger,
  ScanLedgerStatus,
  ScanLedgerCreateInput,
  ScanDenyReason,
} from '../models/scan-ledger.js';
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
  /** Public host-profile lookup — global (not org-scoped): a guest reaches an
   * organization by its slug alone, with no tenant context of their own. */
  getBySlug(slug: string): Promise<Organization | null>;
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
  /** Public venue-profile lookup — global (not org-scoped): the guest surface
   * addresses a venue by slug alone, with no tenant context of its own. */
  getBySlugGlobal(slug: string): Promise<Venue | null>;
  listByOrganization(organizationId: EntityId, query: PaginationQuery): Promise<Page<Venue>>;
  /** Platform-wide venue directory (admin venues view) — global, not org-scoped. */
  listAll(query: PaginationQuery): Promise<Page<Venue>>;
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
  /** Saves (create or update — scan increments version). Version checked for optimistic locking. */
  save(entitlement: Entitlement, tx?: TxContext | null): Promise<void>;
  /** Bulk save for fulfilment (atomic with order creation). */
  saveMany(entitlements: Entitlement[], tx?: TxContext | null): Promise<void>;
  /** Counts valid entitlements for a tier (inventory/sell-through). */
  countValidByTier(tierId: EntityId): Promise<number>;
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
  countConsumedByEntitlement(entitlementId: EntityId): Promise<number>;
  findOfflineScans(eventId: EntityId, before: Date): Promise<ScanLedger[]>;
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
  /** Cross-org admin view — the batch-run and freeze/release queues. */
  listByStatus(status: PayoutStatus, query: PaginationQuery): Promise<Page<Payout>>;
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
  /** Cross-org admin queue. */
  listByStatus(status: DisputeStatus, query: PaginationQuery): Promise<Page<Dispute>>;
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
};
