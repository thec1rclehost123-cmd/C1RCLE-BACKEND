import { NotFoundError } from '../../domain/errors.js';
import { suspendVenue } from '../../domain/models/venue.js';

import type { AdminAuthorityService } from './admin-authority-service.js';
import type { EntityId } from '../../domain/identity.js';
import type { Event } from '../../domain/models/event.js';
import type { Organization } from '../../domain/models/organization.js';
import type { PlatformUser } from '../../domain/models/platform-user.js';
import type { Venue } from '../../domain/models/venue.js';
import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ServiceDeps } from '../context.js';

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

  async listUsers(adminUserId: EntityId, query: PaginationQuery): Promise<Page<PlatformUser>> {
    await this.authority.requireAdmin(adminUserId);
    return this.users.listAll(query);
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

  private async requireVenue(venueId: EntityId): Promise<Venue> {
    const venue = await this.venues.getById(venueId);
    if (!venue) throw new NotFoundError('venue', venueId);
    return venue;
  }
}
