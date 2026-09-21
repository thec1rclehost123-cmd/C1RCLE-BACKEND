import { InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { isExecutable } from '../../domain/models/admin-authority.js';
import {
  reinstatePromoterAssignment,
  suspendPromoterAssignment,
} from '../../domain/models/event-catalog.js';
import {
  adminForceCompleteEvent,
  adminPauseEvent,
  adminResumeEvent,
  isPublicStatus,
} from '../../domain/models/event.js';
import {
  adjustPlatformFeePercent,
  reinstateOrganization,
  suspendOrganization,
} from '../../domain/models/organization.js';
import { banUser, unbanUser } from '../../domain/models/user-ban.js';
import { reinstateVenue, suspendVenue } from '../../domain/models/venue.js';

import type { AdminAuthorityService } from './admin-authority-service.js';
import type { EntityId } from '../../domain/identity.js';
import type { Entitlement } from '../../domain/models/entitlement.js';
import type { PromoCode, PromoterAssignment } from '../../domain/models/event-catalog.js';
import type { Event } from '../../domain/models/event.js';
import type { Order } from '../../domain/models/order.js';
import type { Organization } from '../../domain/models/organization.js';
import type {
  PlatformSettings,
  PlatformSettingsInput,
} from '../../domain/models/platform-settings.js';
import type { PlatformUser } from '../../domain/models/platform-user.js';
import type { Venue } from '../../domain/models/venue.js';
import type { AuditRequestMeta } from '../../domain/ports/audit.js';
import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ServiceDeps } from '../context.js';

/** The admin users view adds ban status; the domain model itself stays clean. */
export type PlatformUserWithBanStatus = PlatformUser & { isBanned: boolean };

/** Caller context (IP / User-Agent) captured at the route and forwarded into the audit record. */
export type AdminRequestMeta = AuditRequestMeta;

/** Bound on the per-collection scan `getAnalyticsSummary` does — see its doc comment. */
const ANALYTICS_SCAN_LIMIT = 1000;

export interface AdminAnalyticsSummary {
  totalRevenuePaise: number;
  ticketsSold: number;
  activeEventsCount: number;
  topOrganizations: { organizationId: EntityId; name: string; revenuePaise: number }[];
  /** How many orders/events were actually scanned — an honest bound, not a claim of exhaustiveness. */
  scannedOrders: number;
  scannedEvents: number;
  /** True when any scanned collection hit the bounded-scan limit — figures are lower bounds. */
  truncated: boolean;
}

/**
 * ─── Admin directory + operations (Phase 7 admin) ───────────────────────────
 * Platform-wide, read-mostly views (venues / events / hosts / users) plus the
 * venue suspension resolver. Every method begins with
 * `AdminAuthorityService.requireAdmin`/`authorize` — authority is never
 * inferred from an organization role.
 *
 * `suspendVenueFromProposal` mirrors `AdminPayoutService`'s resolver shape:
 * execute from the *approved dual-control proposal* (payload read from the
 * proposal, never from the caller's args), then audit with before/after.
 */
export class AdminOperationsService {
  constructor(
    private deps: ServiceDeps,
    private authority: AdminAuthorityService,
  ) {}

  private get venues() {
    return this.deps.repositories.venues;
  }

  private get events() {
    return this.deps.repositories.events;
  }

  private get organizations() {
    return this.deps.repositories.organizations;
  }

  private get users() {
    return this.deps.repositories.users;
  }

  private get userBans() {
    return this.deps.repositories.userBans;
  }

  private get orders() {
    return this.deps.repositories.orders;
  }

  private get entitlements() {
    return this.deps.repositories.entitlements;
  }

  private get catalog() {
    return this.deps.repositories.catalog;
  }

  async listVenues(adminUserId: EntityId, query: PaginationQuery): Promise<Page<Venue>> {
    await this.authority.requireAdmin(adminUserId);
    return this.venues.listAll(query);
  }

  async listEvents(adminUserId: EntityId, query: PaginationQuery): Promise<Page<Event>> {
    await this.authority.requireAdmin(adminUserId);
    return this.events.listAll(query);
  }

  async listHosts(adminUserId: EntityId, query: PaginationQuery): Promise<Page<Organization>> {
    await this.authority.requireAdmin(adminUserId);
    return this.organizations.listAll(query);
  }

  async listUsers(
    adminUserId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<PlatformUserWithBanStatus>> {
    await this.authority.requireAdmin(adminUserId);
    const page = await this.users.listAll(query);
    const items = await Promise.all(
      page.items.map(async (user) => ({
        ...user,
        isBanned: (await this.userBans.getByUserId(user.id))?.isBanned ?? false,
      })),
    );
    return { ...page, items };
  }

  /** Platform-wide order list for the admin order desk. Read-only, any admin. */
  async listOrders(adminUserId: EntityId, query: PaginationQuery): Promise<Page<Order>> {
    await this.authority.requireAdmin(adminUserId);
    return this.orders.listAll(query);
  }

  /**
   * Platform-wide ticket (entitlement) ledger for the admin tickets desk.
   * Read-only, any admin. Distinct from the support-ticket desk — this is
   * the thing a guest actually presents at the door (`entitlement.ts`).
   */
  async listTickets(adminUserId: EntityId, query: PaginationQuery): Promise<Page<Entitlement>> {
    await this.authority.requireAdmin(adminUserId);
    return this.entitlements.listAll(query);
  }

  /**
   * Platform-wide promo code listing for the admin promotions desk.
   * Read-only, any admin — creation/editing stays a partner action
   * (`EventCatalogService.createPromotion`, scoped to their own event).
   */
  async listPromotions(adminUserId: EntityId, query: PaginationQuery): Promise<Page<PromoCode>> {
    await this.authority.requireAdmin(adminUserId);
    return this.catalog.listAllPromos(query);
  }

  /**
   * Platform-wide promoter-assignment listing for the admin promoters desk.
   * V2 has no standalone "promoter" entity — a promoter is an
   * `Organization` member with a versioned commission assignment per event
   * (`PromoterAssignment`). Read-only, any admin.
   */
  async listPromoterAssignments(
    adminUserId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<PromoterAssignment>> {
    await this.authority.requireAdmin(adminUserId);
    return this.catalog.listAllAssignments(query);
  }

  /**
   * Admin: bulk-suspend all active promoter assignments for the given
   * promoter user. Returns the number of assignments actually transitioned
   * (0 if none were active).
   */
  async suspendPromoter(
    adminUserId: EntityId,
    promoterId: EntityId,
    meta?: AdminRequestMeta,
  ): Promise<{ affected: number; at: Date }> {
    const admin = await this.authority.authorize(adminUserId, 'PROMOTER_SUSPEND');
    const now = this.deps.config.clock.now();
    const all = await this.catalog.listAssignmentsByPromoter(promoterId);
    const before = all.map((a) => ({ id: a.id, status: a.status }));
    let affected = 0;
    for (const assignment of all) {
      if (assignment.status === 'active') {
        await this.catalog.saveAssignment(suspendPromoterAssignment(assignment, now));
        affected += 1;
      }
    }
    if (affected > 0) {
      const after = (await this.catalog.listAssignmentsByPromoter(promoterId)).map((a) => ({
        id: a.id,
        status: a.status,
      }));
      await this.authority.record(admin, {
        action: 'PROMOTER_SUSPEND',
        targetType: 'promoter',
        targetId: promoterId,
        before: { assignments: before },
        after: { assignments: after },
        reason: null,
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      });
    }
    return { affected, at: now };
  }

  /**
   * Admin: bulk-reinstate all suspended promoter assignments for the given
   * promoter user. Returns the number of assignments actually transitioned
   * (0 if none were suspended).
   */
  async reinstatePromoter(
    adminUserId: EntityId,
    promoterId: EntityId,
    meta?: AdminRequestMeta,
  ): Promise<{ affected: number; at: Date }> {
    const admin = await this.authority.authorize(adminUserId, 'PROMOTER_REINSTATE');
    const now = this.deps.config.clock.now();
    const all = await this.catalog.listAssignmentsByPromoter(promoterId);
    const before = all.map((a) => ({ id: a.id, status: a.status }));
    let affected = 0;
    for (const assignment of all) {
      if (assignment.status === 'suspended') {
        await this.catalog.saveAssignment(reinstatePromoterAssignment(assignment, now));
        affected += 1;
      }
    }
    if (affected > 0) {
      const after = (await this.catalog.listAssignmentsByPromoter(promoterId)).map((a) => ({
        id: a.id,
        status: a.status,
      }));
      await this.authority.record(admin, {
        action: 'PROMOTER_REINSTATE',
        targetType: 'promoter',
        targetId: promoterId,
        before: { assignments: before },
        after: { assignments: after },
        reason: null,
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      });
    }
    return { affected, at: now };
  }

  /**
   * Admin: read the singleton platform settings doc. Returns defaults
   * if the doc has never been written.
   */
  async getPlatformSettings(adminUserId: EntityId): Promise<PlatformSettings> {
    await this.authority.requireAdmin(adminUserId);
    return this.deps.repositories.platformSettings.get();
  }

  /**
   * Admin: merge-update the singleton platform settings doc. Only supplied
   * fields are overwritten; the rest are preserved from the current doc.
   */
  async updatePlatformSettings(
    adminUserId: EntityId,
    patch: PlatformSettingsInput,
    meta?: AdminRequestMeta,
  ): Promise<PlatformSettings> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const current = await this.deps.repositories.platformSettings.get();
    const updated: PlatformSettings = {
      ...current,
      ...patch,
      featureFlags: patch.featureFlags ?? current.featureFlags,
      updatedAt: this.deps.config.clock.now().toISOString(),
    };
    await this.deps.repositories.platformSettings.save(updated);
    await this.authority.record(admin, {
      action: 'PLATFORM_SETTINGS_UPDATE',
      targetType: 'platform_settings',
      targetId: 'singleton',
      before: {
        platformFeeRate: current.platformFeeRate,
        refundSingleApproverThresholdPaise: current.refundSingleApproverThresholdPaise,
        refundDualApproverThresholdPaise: current.refundDualApproverThresholdPaise,
        maintenanceMode: current.maintenanceMode,
      },
      after: {
        platformFeeRate: updated.platformFeeRate,
        refundSingleApproverThresholdPaise: updated.refundSingleApproverThresholdPaise,
        refundDualApproverThresholdPaise: updated.refundDualApproverThresholdPaise,
        maintenanceMode: updated.maintenanceMode,
      },
      reason: null,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return updated;
  }

  /**
   * Platform-wide revenue/ticket/event summary for the admin analytics
   * desk. Read-only, any admin. Aggregates over the most recent
   * `ANALYTICS_SCAN_LIMIT` orders/events/organizations rather than the
   * whole collection — same bounded-scan shape `exportUsers`/`exportAudit`
   * already use, not a full-collection reduce triggered synchronously on
   * every request (the exact anti-pattern v1's `computePlatformStats` was
   * criticized for — see the V1 audit doc).
   */
  async getAnalyticsSummary(adminUserId: EntityId): Promise<AdminAnalyticsSummary> {
    await this.authority.requireAdmin(adminUserId);

    const [orderPage, eventPage, orgPage] = await Promise.all([
      this.orders.listAll({ limit: ANALYTICS_SCAN_LIMIT, cursor: null }),
      this.events.listAll({ limit: ANALYTICS_SCAN_LIMIT, cursor: null }),
      this.organizations.listAll({ limit: ANALYTICS_SCAN_LIMIT, cursor: null }),
    ]);

    const truncated =
      orderPage.items.length >= ANALYTICS_SCAN_LIMIT ||
      eventPage.items.length >= ANALYTICS_SCAN_LIMIT ||
      orgPage.items.length >= ANALYTICS_SCAN_LIMIT;

    const orgNameById = new Map(orgPage.items.map((org) => [org.id, org.name]));
    const revenueByOrg = new Map<EntityId, number>();
    let totalRevenuePaise = 0;
    let ticketsSold = 0;

    for (const order of orderPage.items) {
      // Money was actually captured for these three states; a still-open
      // cart or a failed/expired/cancelled attempt never took a payment.
      if (
        order.status !== 'paid' &&
        order.status !== 'refund_requested' &&
        order.status !== 'refunded'
      ) {
        continue;
      }
      const netPaise = order.grandTotalPaise - order.refundedPaise;
      totalRevenuePaise += netPaise;
      ticketsSold += order.lines.reduce((sum, line) => sum + line.quantity, 0);
      revenueByOrg.set(
        order.organizationId,
        (revenueByOrg.get(order.organizationId) ?? 0) + netPaise,
      );
    }

    const topOrganizations = [...revenueByOrg.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([organizationId, revenuePaise]) => ({
        organizationId,
        name: orgNameById.get(organizationId) ?? organizationId,
        revenuePaise,
      }));

    return {
      totalRevenuePaise,
      ticketsSold,
      activeEventsCount: eventPage.items.filter((event) => isPublicStatus(event.status)).length,
      topOrganizations,
      scannedOrders: orderPage.items.length,
      scannedEvents: eventPage.items.length,
      truncated,
    };
  }

  /** Bans a user. TIER2, direct command. Idempotent on repeat. */
  async banUser(
    adminUserId: EntityId,
    targetUserId: EntityId,
    reason?: string,
    meta?: AdminRequestMeta,
  ): Promise<PlatformUserWithBanStatus> {
    const admin = await this.authority.authorize(adminUserId, 'USER_BAN');
    const existing = await this.userBans.getByUserId(targetUserId);
    const banned = banUser(existing, targetUserId, { bannedBy: admin.id, reason });
    if (banned !== existing) {
      await this.userBans.save(banned);
      await this.authority.record(admin, {
        action: 'USER_BAN',
        targetType: 'platform_user',
        targetId: targetUserId,
        before: { isBanned: existing?.isBanned ?? false },
        after: { isBanned: banned.isBanned },
        reason: banned.banReason,
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      });
    }
    return this.withBanStatus(targetUserId, banned.isBanned);
  }

  /** Reverses `banUser`. TIER2, direct command. Idempotent on repeat. */
  async unbanUser(
    adminUserId: EntityId,
    targetUserId: EntityId,
    meta?: AdminRequestMeta,
  ): Promise<PlatformUserWithBanStatus> {
    const admin = await this.authority.authorize(adminUserId, 'USER_UNBAN');
    const existing = await this.userBans.getByUserId(targetUserId);
    if (!existing) return this.withBanStatus(targetUserId, false);
    const unbanned = unbanUser(existing);
    if (unbanned !== existing) {
      await this.userBans.save(unbanned);
      await this.authority.record(admin, {
        action: 'USER_UNBAN',
        targetType: 'platform_user',
        targetId: targetUserId,
        before: { isBanned: existing.isBanned },
        after: { isBanned: unbanned.isBanned },
        reason: null,
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      });
    }
    return this.withBanStatus(targetUserId, unbanned.isBanned);
  }

  /**
   * Assembles the admin-facing user view. Banning/unbanning a user id that
   * isn't in the directory (yet, or ever) still succeeds — the ban record
   * is independent of `UserAccountRepository`, which is read-only by
   * design — so this falls back to a minimal shape rather than 404ing.
   */
  private async withBanStatus(
    userId: EntityId,
    isBanned: boolean,
  ): Promise<PlatformUserWithBanStatus> {
    const found = await this.users.getById(userId);
    if (found) return { ...found, isBanned };
    return {
      id: userId,
      // A syntactically valid placeholder — the wire DTO requires a real
      // email shape even for a ban record with no matching directory entry.
      email: `${userId}@unknown.c1rcle.internal`,
      name: '',
      image: null,
      emailVerified: false,
      role: null,
      createdAt: 0,
      updatedAt: 0,
      isBanned,
    };
  }

  /**
   * CSV export of the user directory, with PII redaction — ported from
   * v1's `exports/route.js`. Only `super`/`finance` see a real email;
   * every other role gets it redacted, matching v1's rule verbatim. The
   * export itself is audited with the row count, same as `exportAudit`.
   */
  async exportUsers(
    adminUserId: EntityId,
    meta?: AdminRequestMeta,
  ): Promise<{
    rows: PlatformUserWithBanStatus[];
    redactEmail: boolean;
  }> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const redactEmail = admin.role !== 'super' && admin.role !== 'finance';
    const page = await this.listUsers(adminUserId, { limit: 1000, cursor: null });
    await this.authority.record(admin, {
      action: 'ADMIN_EXPORT',
      targetType: 'user_directory',
      targetId: admin.id,
      before: null,
      after: { rows: page.items.length },
      reason: null,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return { rows: page.items, redactEmail };
  }

  /** CSV export of the admin audit trail; a matching audit row is recorded. */
  async exportAudit(adminUserId: EntityId, limit: number, meta?: AdminRequestMeta) {
    const admin = await this.authority.requireAdmin(adminUserId);
    const rows = await this.authority.listAudit(adminUserId, limit);
    await this.authority.record(admin, {
      action: 'ADMIN_EXPORT',
      targetType: 'audit_log',
      targetId: admin.id,
      before: null,
      after: { limit, rows: rows.length },
      reason: null,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return rows;
  }

  /**
   * Suspends a venue. TIER2, direct command (the domain model grants
   * `VENUE_SUSPEND` to a single `ops`/`finance`/`admin`/`super` admin — only
   * TIER3 actions route through dual control; `proposeAction` refuses lower
   * tiers outright). Audits before/after; idempotent on repeat.
   */
  async suspendVenue(
    adminUserId: EntityId,
    venueId: EntityId,
    meta?: AdminRequestMeta,
  ): Promise<Venue> {
    const admin = await this.authority.authorize(adminUserId, 'VENUE_SUSPEND');
    const venue = await this.requireVenue(venueId);
    const now = this.deps.config.clock.now();
    const suspended = suspendVenue(venue, now);
    if (suspended === venue) return venue;
    await this.venues.save(suspended);
    await this.authority.record(admin, {
      action: 'VENUE_SUSPEND',
      targetType: 'venue',
      targetId: venue.id,
      before: { status: venue.status },
      after: { status: suspended.status },
      reason: null,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return suspended;
  }

  /**
   * Adjusts an organization's platform commission. TIER3, dual control:
   * executes only from an approved `COMMISSION_ADJUST` proposal, reading
   * `organizationId`/`platformFeePercent` from the proposal's payload —
   * never from this call's own arguments — same shape as
   * `AdminPayoutService`'s freeze/release resolvers.
   */
  async adjustCommissionFromProposal(
    adminUserId: EntityId,
    proposalId: EntityId,
    meta?: AdminRequestMeta,
  ): Promise<Organization> {
    const admin = await this.authority.authorize(adminUserId, 'COMMISSION_ADJUST');
    const proposal = await this.authority.getProposal(adminUserId, proposalId);
    if (proposal.action !== 'COMMISSION_ADJUST') {
      throw new InvalidOperationError('This proposal does not adjust a commission');
    }
    if (!isExecutable(proposal)) {
      throw new InvalidOperationError('This proposal has not been approved by a second admin');
    }
    const { organizationId, platformFeePercent } = readCommissionPayload(proposal.payload);
    const org = await this.organizations.getById(organizationId);
    if (!org) throw new NotFoundError('organization', organizationId);

    const adjusted = adjustPlatformFeePercent(
      org,
      platformFeePercent,
      this.deps.config.clock.now(),
    );
    if (adjusted !== org) await this.organizations.save(adjusted);
    await this.authority.record(admin, {
      action: 'COMMISSION_ADJUST',
      targetType: 'organization',
      targetId: org.id,
      before: { platformFeePercent: org.platformFeePercent },
      after: { platformFeePercent: adjusted.platformFeePercent },
      reason: proposal.reason,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return adjusted;
  }

  /** Reinstates a suspended venue. TIER2, direct command, mirrors `suspendVenue`. */
  async reinstateVenue(
    adminUserId: EntityId,
    venueId: EntityId,
    meta?: AdminRequestMeta,
  ): Promise<Venue> {
    const admin = await this.authority.authorize(adminUserId, 'VENUE_REINSTATE');
    const venue = await this.requireVenue(venueId);
    const now = this.deps.config.clock.now();
    const reinstated = reinstateVenue(venue, now);
    if (reinstated === venue) return venue;
    await this.venues.save(reinstated);
    await this.authority.record(admin, {
      action: 'VENUE_REINSTATE',
      targetType: 'venue',
      targetId: venue.id,
      before: { status: venue.status },
      after: { status: reinstated.status },
      reason: null,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return reinstated;
  }

  /**
   * Suspends an organization. TIER2, direct command. V1 modelled host/venue/
   * promoter as separate entity types with separate suspend actions; v2
   * unifies them into `Organization` (capabilities live on members, not on
   * a type-per-tenant), so this single action covers all three.
   */
  async suspendOrganization(
    adminUserId: EntityId,
    organizationId: EntityId,
    meta?: AdminRequestMeta,
  ): Promise<Organization> {
    const admin = await this.authority.authorize(adminUserId, 'ORGANIZATION_SUSPEND');
    const org = await this.requireOrganization(organizationId);
    const now = this.deps.config.clock.now();
    const suspended = suspendOrganization(org, now);
    if (suspended === org) return org;
    await this.organizations.save(suspended);
    await this.authority.record(admin, {
      action: 'ORGANIZATION_SUSPEND',
      targetType: 'organization',
      targetId: org.id,
      before: { status: org.status },
      after: { status: suspended.status },
      reason: null,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return suspended;
  }

  /** Reinstates a suspended organization. TIER2, direct command. */
  async reinstateOrganization(
    adminUserId: EntityId,
    organizationId: EntityId,
    meta?: AdminRequestMeta,
  ): Promise<Organization> {
    const admin = await this.authority.authorize(adminUserId, 'ORGANIZATION_REINSTATE');
    const org = await this.requireOrganization(organizationId);
    const now = this.deps.config.clock.now();
    const reinstated = reinstateOrganization(org, now);
    if (reinstated === org) return org;
    await this.organizations.save(reinstated);
    await this.authority.record(admin, {
      action: 'ORGANIZATION_REINSTATE',
      targetType: 'organization',
      targetId: org.id,
      before: { status: org.status },
      after: { status: reinstated.status },
      reason: null,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return reinstated;
  }

  /**
   * Admin override pause. TIER1 — any admin may call it, the action is
   * merely logged (no role gate beyond being an active admin at all).
   */
  async pauseEvent(
    adminUserId: EntityId,
    eventId: EntityId,
    meta?: AdminRequestMeta,
  ): Promise<Event> {
    const admin = await this.authority.authorize(adminUserId, 'EVENT_PAUSE');
    const event = await this.requireEvent(eventId);
    const now = this.deps.config.clock.now();
    const paused = adminPauseEvent(event, now);
    if (paused === event) return event;
    await this.events.save(paused);
    await this.authority.record(admin, {
      action: 'EVENT_PAUSE',
      targetType: 'event',
      targetId: event.id,
      before: { status: event.status, adminOverride: event.adminOverride },
      after: { status: paused.status, adminOverride: paused.adminOverride },
      reason: null,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return paused;
  }

  /** Admin override resume. TIER1, reverses `pauseEvent`. */
  async resumeEvent(
    adminUserId: EntityId,
    eventId: EntityId,
    meta?: AdminRequestMeta,
  ): Promise<Event> {
    const admin = await this.authority.authorize(adminUserId, 'EVENT_RESUME');
    const event = await this.requireEvent(eventId);
    const now = this.deps.config.clock.now();
    const resumed = adminResumeEvent(event, now);
    if (resumed === event) return event;
    await this.events.save(resumed);
    await this.authority.record(admin, {
      action: 'EVENT_RESUME',
      targetType: 'event',
      targetId: event.id,
      before: { status: event.status, adminOverride: event.adminOverride },
      after: { status: resumed.status, adminOverride: resumed.adminOverride },
      reason: null,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return resumed;
  }

  /**
   * Admin force-complete (`EVENT_FORCE_PAUSE`, TIER1). Sometimes a past event
   * never leaves the FSM on its own — a sales window closed days ago but the
   * status is still `published`, or a `started` event that never hit `ended`.
   * This lets an admin force the FSM's admin-only terminal edge rather than
   * leaving a zombie. Mirrors `pauseEvent`'s direct-command + audit-log shape.
   */
  async forceCompleteEvent(
    adminUserId: EntityId,
    eventId: EntityId,
    meta?: AdminRequestMeta,
  ): Promise<Event> {
    const admin = await this.authority.authorize(adminUserId, 'EVENT_FORCE_PAUSE');
    const event = await this.requireEvent(eventId);
    const now = this.deps.config.clock.now();
    const completed = adminForceCompleteEvent(event, now);
    if (completed === event) return event;
    await this.events.save(completed);
    await this.authority.record(admin, {
      action: 'EVENT_FORCE_PAUSE',
      targetType: 'event',
      targetId: event.id,
      before: { status: event.status, adminOverride: event.adminOverride },
      after: { status: completed.status, adminOverride: completed.adminOverride },
      reason: null,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return completed;
  }

  private async requireEvent(eventId: EntityId): Promise<Event> {
    const event = await this.events.getById(eventId);
    if (!event) throw new NotFoundError('event', eventId);
    return event;
  }

  /**
   * Resolves audit-record targets to human-readable names for display —
   * a small lookup helper, not baked into the audit write itself (v1's
   * equivalent walked a 12-entry collection map at read time too;
   * `logAdminAction` never stored a name). Unresolvable/unknown target
   * types return `null` rather than throwing — a display nicety is never
   * worth failing the whole audit read over.
   *
   * `adminUserId` is the *viewer*, not the actor who performed the
   * audited action — a `platform_user` target's email is only resolved
   * for `super`/`finance` viewers, the same redaction rule `exportUsers`
   * uses. Without this, any admin (including `support`) could read a
   * banned user's real email straight out of the audit trail even though
   * the CSV export redacts it for that same role.
   */
  async resolveTargetNames(
    adminUserId: EntityId,
    targets: readonly { targetType?: string; targetId?: EntityId }[],
  ): Promise<Map<string, string | null>> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const canSeeEmail = admin.role === 'super' || admin.role === 'finance';
    const result = new Map<string, string | null>();
    await Promise.all(
      targets.map(async ({ targetType, targetId }) => {
        const key = `${targetType ?? ''}:${targetId ?? ''}`;
        if (result.has(key) || targetId === undefined) return;
        result.set(key, await this.resolveOneTargetName(targetType, targetId, canSeeEmail));
      }),
    );
    return result;
  }

  private async resolveOneTargetName(
    targetType: string | undefined,
    targetId: EntityId,
    canSeeEmail: boolean,
  ): Promise<string | null> {
    if (targetType === undefined) return null;
    switch (targetType) {
      case 'venue':
        return (await this.venues.getById(targetId))?.public.name ?? null;
      case 'event':
        return (await this.events.getById(targetId))?.title ?? null;
      case 'organization':
        return (await this.organizations.getById(targetId))?.name ?? null;
      case 'platform_user':
        if (!canSeeEmail) return null;
        return (await this.users.getById(targetId))?.email ?? null;
      default:
        return null;
    }
  }

  /**
   * Global entity lookup (the "omnibox"). Ported from v1's `lookup/route.js`:
   * parallel O(1) doc-id fetches across known collections rather than a
   * scan. Read-only, any admin. Below 3 characters returns no results —
   * a 1-2 char id lookup is never meaningful, so there is nothing to save
   * by even issuing the reads.
   */
  async globalLookup(
    adminUserId: EntityId,
    query: string,
  ): Promise<{ type: 'venue' | 'event' | 'organization' | 'user'; id: EntityId; label: string }[]> {
    await this.authority.requireAdmin(adminUserId);
    const q = query.trim();
    if (q.length < 3) return [];

    // An email can never collide with an opaque entity id, so both lookups
    // run unconditionally rather than branching on `q`'s shape — cheap
    // (single-field-indexed) and matches v1's parallel by-id + by-email search.
    const [venue, event, organization, userById, userByEmail] = await Promise.all([
      this.venues.getById(q),
      this.events.getById(q),
      this.organizations.getById(q),
      this.users.getById(q),
      this.users.getByEmail(q),
    ]);
    const user = userById ?? userByEmail;

    const results: {
      type: 'venue' | 'event' | 'organization' | 'user';
      id: EntityId;
      label: string;
    }[] = [];
    if (venue) results.push({ type: 'venue', id: venue.id, label: venue.public.name });
    if (event) results.push({ type: 'event', id: event.id, label: event.title });
    if (organization)
      results.push({ type: 'organization', id: organization.id, label: organization.name });
    if (user) results.push({ type: 'user', id: user.id, label: user.email });
    return results;
  }

  private async requireVenue(venueId: EntityId): Promise<Venue> {
    const venue = await this.venues.getById(venueId);
    if (!venue) throw new NotFoundError('venue', venueId);
    return venue;
  }

  private async requireOrganization(organizationId: EntityId): Promise<Organization> {
    const org = await this.organizations.getById(organizationId);
    if (!org) throw new NotFoundError('organization', organizationId);
    return org;
  }
}

function readCommissionPayload(payload: Record<string, unknown>): {
  organizationId: EntityId;
  platformFeePercent: number;
} {
  const organizationId = payload.organizationId;
  const platformFeePercent = payload.platformFeePercent;
  if (typeof organizationId !== 'string' || organizationId.length === 0) {
    throw new InvalidOperationError('Proposal payload is missing `organizationId`');
  }
  if (typeof platformFeePercent !== 'number') {
    throw new InvalidOperationError('Proposal payload is missing `platformFeePercent`');
  }
  return { organizationId, platformFeePercent };
}
