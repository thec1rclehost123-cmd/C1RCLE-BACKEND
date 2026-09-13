import { InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { isExecutable } from '../../domain/models/admin-authority.js';
import { adminPauseEvent, adminResumeEvent } from '../../domain/models/event.js';
import {
  adjustPlatformFeePercent,
  reinstateOrganization,
  suspendOrganization,
} from '../../domain/models/organization.js';
import { banUser, unbanUser } from '../../domain/models/user-ban.js';
import { reinstateVenue, suspendVenue } from '../../domain/models/venue.js';

import type { AdminAuthorityService } from './admin-authority-service.js';
import type { EntityId } from '../../domain/identity.js';
import type { Event } from '../../domain/models/event.js';
import type { Organization } from '../../domain/models/organization.js';
import type { PlatformUser } from '../../domain/models/platform-user.js';
import type { Venue } from '../../domain/models/venue.js';
import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ServiceDeps } from '../context.js';

/** The admin users view adds ban status; the domain model itself stays clean. */
export type PlatformUserWithBanStatus = PlatformUser & { isBanned: boolean };

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

  /** Bans a user. TIER2, direct command. Idempotent on repeat. */
  async banUser(
    adminUserId: EntityId,
    targetUserId: EntityId,
    reason?: string,
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
      });
    }
    return this.withBanStatus(targetUserId, banned.isBanned);
  }

  /** Reverses `banUser`. TIER2, direct command. Idempotent on repeat. */
  async unbanUser(
    adminUserId: EntityId,
    targetUserId: EntityId,
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

  /** CSV export of the admin audit trail; a matching audit row is recorded. */
  async exportAudit(adminUserId: EntityId, limit: number) {
    const admin = await this.authority.requireAdmin(adminUserId);
    const rows = await this.authority.listAudit(adminUserId, limit);
    await this.authority.record(admin, {
      action: 'ADMIN_EXPORT',
      targetType: 'audit_log',
      targetId: admin.id,
      before: null,
      after: { limit, rows: rows.length },
      reason: null,
    });
    return rows;
  }

  /**
   * Suspends a venue. TIER2, direct command (the domain model grants
   * `VENUE_SUSPEND` to a single `ops`/`finance`/`admin`/`super` admin — only
   * TIER3 actions route through dual control; `proposeAction` refuses lower
   * tiers outright). Audits before/after; idempotent on repeat.
   */
  async suspendVenue(adminUserId: EntityId, venueId: EntityId): Promise<Venue> {
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
    });
    return adjusted;
  }

  /** Reinstates a suspended venue. TIER2, direct command, mirrors `suspendVenue`. */
  async reinstateVenue(adminUserId: EntityId, venueId: EntityId): Promise<Venue> {
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
    });
    return suspended;
  }

  /** Reinstates a suspended organization. TIER2, direct command. */
  async reinstateOrganization(
    adminUserId: EntityId,
    organizationId: EntityId,
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
    });
    return reinstated;
  }

  /**
   * Admin override pause. TIER1 — any admin may call it, the action is
   * merely logged (no role gate beyond being an active admin at all).
   */
  async pauseEvent(adminUserId: EntityId, eventId: EntityId): Promise<Event> {
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
    });
    return paused;
  }

  /** Admin override resume. TIER1, reverses `pauseEvent`. */
  async resumeEvent(adminUserId: EntityId, eventId: EntityId): Promise<Event> {
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
    });
    return resumed;
  }

  private async requireEvent(eventId: EntityId): Promise<Event> {
    const event = await this.events.getById(eventId);
    if (!event) throw new NotFoundError('event', eventId);
    return event;
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
