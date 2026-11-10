import { OrganizationNotFoundError } from '../../domain/errors.js';
import { isLive } from '../../domain/models/partnership.js';
import { isConnectionLive } from '../../domain/models/promoter-connection.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { Capability } from '../../domain/models/organization.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * ─── Partner discovery service ──────────────────────────────────────────────
 *
 * Browse surface behind `GET /organizations/:id/discover-partners`: real
 * organizations/venues the caller could connect with — never dummy profiles.
 * An empty database yields an empty list, which the UI renders as an empty
 * state.
 *
 * Bounds, not deep pagination: every backing read is capped (`BROWSE_CAP`)
 * and kind/search/cursor filtering happens in code, so neither storage
 * driver needs new composite indexes. Exclusions keep "Send Request" honest:
 * the caller's own org, non-active rows (never returned by the browse
 * reads), and counterparts with a *live* partnership/connection are skipped,
 * so answering the card cannot 400 as "already requested".
 */

export type DiscoverPartnerKind = 'host' | 'venue' | 'promoter';

export interface DiscoverPartnersQuery {
  type?: DiscoverPartnerKind;
  q?: string;
  cursor?: string | null;
  /** 1–100; enforced again by the route schema. */
  limit: number;
}

export interface DiscoveredPartner {
  id: EntityId;
  kind: DiscoverPartnerKind;
  name: string;
  slug: string;
  city: string | null;
  /** No organization verification concept exists yet — always false. */
  verified: boolean;
  /** Organization behind a host/promoter candidate; venue's owning org for venues. */
  organizationId: EntityId | null;
  /** Venue behind a venue candidate (the partnership request key). */
  venueId: EntityId | null;
  photoUrl?: string | null;
  coverUrl?: string | null;
  bio?: string;
  genres?: string[];
  stats?: { label: string; value: string }[];
}

export interface DiscoverPartnersPage {
  items: DiscoveredPartner[];
  total: number;
  nextCursor: string | null;
}

/** Caps every backing read. Discover itself caps at 100 per contract. */
const BROWSE_CAP = 200;

export class PartnerDiscoveryService {
  constructor(private deps: ServiceDeps) {}

  async discover(
    actor: ActorContext,
    organizationId: EntityId,
    query: DiscoverPartnersQuery,
  ): Promise<DiscoverPartnersPage> {
    requireOrgAccess(actor, organizationId);
    const caller = await this.deps.repositories.organizations.getById(organizationId);
    if (!caller) throw new OrganizationNotFoundError(organizationId);

    const [orgs, venues, partnerships, connections] = await Promise.all([
      this.deps.repositories.organizations.listActive(BROWSE_CAP),
      this.deps.repositories.venues.listActive(BROWSE_CAP),
      this.deps.repositories.partnerships.listForOrganization(organizationId, {
        limit: BROWSE_CAP,
      }),
      this.deps.repositories.promoterConnections.listForOrganization(organizationId, {
        limit: BROWSE_CAP,
      }),
    ]);
    const venueOwners = await this.deps.repositories.organizations.getByIds([
      ...new Set(venues.map((venue) => venue.organizationId)),
    ]);
    const venueOwnerById = new Map(venueOwners.map((owner) => [owner.id, owner] as const));

    // Counterparts a new request to would collide with ("one live per pair").
    const livePartnerOrgIds = new Set<EntityId>();
    const liveVenueIds = new Set<EntityId>();
    for (const p of partnerships.items) {
      if (!isLive(p)) continue;
      liveVenueIds.add(p.venueId);
      if (p.hostOrganizationId !== organizationId) livePartnerOrgIds.add(p.hostOrganizationId);
      if (p.venueOrganizationId !== organizationId) livePartnerOrgIds.add(p.venueOrganizationId);
    }
    const liveConnectionOrgIds = new Set<EntityId>();
    for (const c of connections.items) {
      if (!isConnectionLive(c)) continue;
      if (c.promoterId !== organizationId) liveConnectionOrgIds.add(c.promoterId);
      if (c.targetId !== organizationId) liveConnectionOrgIds.add(c.targetId);
    }

    const needle = query.q?.trim().toLowerCase() ?? null;
    const matchesQ = (name: string): boolean =>
      needle === null || name.toLowerCase().includes(needle);
    const wants = (kind: DiscoverPartnerKind): boolean =>
      query.type === undefined || query.type === kind;

    const items: DiscoveredPartner[] = [];

    if (wants('host') || wants('promoter')) {
      for (const org of orgs) {
        if (org.id === organizationId) continue;
        if (livePartnerOrgIds.has(org.id) || liveConnectionOrgIds.has(org.id)) continue;
        // Pre-Phase-2 documents can predate `members`; an org without a member
        // list advertises no capability and is skipped rather than crashed on.
        const members = Array.isArray(org.members) ? org.members : [];
        const capabilities = new Set<Capability>(members.flatMap((m) => m.capabilities));
        // An org holding both capabilities appears once, as host first — the
        // dashboard splits kinds itself and de-dupes by id regardless.
        let kind: DiscoverPartnerKind | null = null;
        if (wants('host') && capabilities.has('host')) kind = 'host';
        else if (wants('promoter') && capabilities.has('promoter')) kind = 'promoter';
        if (kind === null || !matchesQ(org.name)) continue;
        if (org.settings.partnerPrivacy?.profileVisible === false) continue;
        const profile = org.settings.partnerProfile ?? {};
        items.push({
          id: org.id,
          kind,
          name: profile.displayName ?? org.name,
          slug: org.slug,
          city: null,
          verified: false,
          organizationId: org.id,
          venueId: null,
          photoUrl: profile.photoUrl ?? null,
          coverUrl: profile.coverUrl ?? null,
          bio: profile.bio ?? '',
          genres: profile.genres ?? [],
          stats: [],
        });
      }
    }

    if (wants('venue')) {
      for (const venue of venues) {
        if (venue.organizationId === organizationId) continue;
        if (liveVenueIds.has(venue.id)) continue;
        const owner = venueOwnerById.get(venue.organizationId);
        if (
          !owner ||
          owner.status !== 'active' ||
          owner.settings.partnerPrivacy?.profileVisible === false
        )
          continue;
        if (!matchesQ(venue.public.name)) continue;
        items.push({
          id: venue.id,
          kind: 'venue',
          name: venue.public.name,
          slug: venue.public.slug,
          city: venue.public.address?.city ?? null,
          verified: false,
          organizationId: venue.organizationId,
          venueId: venue.id,
          photoUrl: venue.public.photoUrl,
          coverUrl: venue.public.coverUrl ?? null,
          bio: venue.public.description,
          genres: venue.public.genres ?? [],
          stats: [
            {
              label: 'Capacity',
              value:
                venue.public.capacity === null
                  ? 'Not listed'
                  : venue.public.capacity.toLocaleString('en-IN'),
            },
          ],
        });
      }
    }

    // Id-offset cursor over the filtered list (bounded arrays only).
    const total = items.length;
    const start =
      query.cursor != null ? items.findIndex((item) => item.id === query.cursor) + 1 : 0;
    const slice = items.slice(start, start + query.limit);
    const last = slice[slice.length - 1];
    const nextCursor = start + query.limit < total && last ? last.id : null;
    return { items: slice, total, nextCursor };
  }
}
