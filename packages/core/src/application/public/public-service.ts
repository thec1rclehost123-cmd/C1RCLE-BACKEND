import {
  EventNotFoundError,
  VenueNotFoundError,
  OrganizationNotFoundError,
} from '../../domain/errors.js';
import { isPublicStatus } from '../../domain/models/event.js';

import type { EntityId } from '../../domain/identity.js';
import type { Event } from '../../domain/models/event.js';
import type { Organization } from '../../domain/models/organization.js';
import type { Venue } from '../../domain/models/venue.js';
import type {
  EventRepository,
  OrganizationRepository,
  Page,
  PaginationQuery,
  VenueRepository,
} from '../../domain/ports/repositories.js';
import type { ServiceDeps } from '../context.js';

/**
 * ─── Public / discovery reads (Phase 4 §6) ───────────────────────────────────
 * Unauthenticated guest-facing reads: no `ActorContext`, no writes, no
 * business decisions — just the "only what's public" filter that every
 * method here enforces before returning anything. Thin orchestration over
 * repositories, same shape as every other application service (T08).
 */

/** Upper bound for the curated feed — no distinct "featured" concept exists
 * yet (see `discovery()`), so this is also the aggregate's page size. */
const DISCOVERY_LIMIT = 20;

/** Upper bound for the naive search scan (see `search()`). */
const SEARCH_SCAN_LIMIT = 100;

export class PublicService {
  constructor(private deps: ServiceDeps) {}

  private get events(): EventRepository {
    return this.deps.repositories.events;
  }

  private get venues(): VenueRepository {
    return this.deps.repositories.venues;
  }

  private get organizations(): OrganizationRepository {
    return this.deps.repositories.organizations;
  }

  /** Published/discoverable events only — `listPublic` is already filtered by
   * the domain's `isPublic` flag, so a draft/cancelled event can never appear. */
  async listEvents(query: PaginationQuery): Promise<Page<Event>> {
    return this.events.listPublic(query);
  }

  /**
   * `idOrSlug`: tries the id first (cheap point read), falls back to a slug
   * lookup. Only a currently-public event is ever returned — a real but
   * non-public event (draft, review, cancelled, …) reports the same
   * `event_not_found` as a truly missing id, so this is never an existence
   * oracle for unpublished work.
   */
  async getEvent(idOrSlug: EntityId): Promise<Event> {
    const byId = await this.events.getById(idOrSlug);
    const event = byId ?? (await this.events.getBySlug(idOrSlug));
    if (!event || !isPublicStatus(event.status)) {
      throw new EventNotFoundError(idOrSlug);
    }
    return event;
  }

  /** Venue public profile by slug. A suspended venue is not discoverable. */
  async getVenue(slug: string): Promise<Venue> {
    const venue = await this.venues.getBySlugGlobal(slug);
    if (!venue || venue.status !== 'active') {
      throw new VenueNotFoundError(slug);
    }
    return venue;
  }

  /** Host/organization public profile by slug. Only an active tenant is public. */
  async getHost(slug: string): Promise<Organization> {
    const org = await this.organizations.getBySlug(slug);
    if (!org || org.status !== 'active') {
      throw new OrganizationNotFoundError(slug);
    }
    return org;
  }

  /**
   * Curated/featured feed. No distinct "featured" domain concept exists yet
   * (nothing marks an event as editorially curated), so this is a reasonable
   * aggregate instead: the soonest-starting published events, capped at
   * `DISCOVERY_LIMIT`. Revisit if/when curation becomes a real concept.
   */
  async discovery(): Promise<Event[]> {
    const page = await this.events.listPublic({ limit: DISCOVERY_LIMIT });
    return [...page.items].sort((a, b) => a.startAt.localeCompare(b.startAt));
  }

  /**
   * Substring search over title/summary/tags. No search index exists yet, so
   * this scans a bounded page of public events (`SEARCH_SCAN_LIMIT`) rather
   * than the whole collection — a real index (e.g. Algolia/Typesense) is
   * future work, tracked here as a known limitation rather than silently
   * presented as full-text search over the entire catalogue.
   */
  async search(q: string, query: PaginationQuery): Promise<Page<Event>> {
    const needle = q.trim().toLowerCase();
    const page = await this.events.listPublic({ limit: SEARCH_SCAN_LIMIT });
    const matches = page.items.filter((event) => matchesQuery(event, needle));
    const start = query.cursor ? matches.findIndex((event) => event.id === query.cursor) + 1 : 0;
    const end = Math.min(start + query.limit, matches.length);
    const items = matches.slice(start, end);
    const last = items[items.length - 1];
    return {
      items,
      total: matches.length,
      nextCursor: end < matches.length && last ? last.id : null,
    };
  }
}

function matchesQuery(event: Event, needle: string): boolean {
  if (needle.length === 0) return true;
  return (
    event.title.toLowerCase().includes(needle) ||
    event.summary.toLowerCase().includes(needle) ||
    event.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
}
