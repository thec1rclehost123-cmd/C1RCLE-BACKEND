import { VersionConflictError } from '../../domain/errors.js';

/**
 * ─── In-memory repository implementations (Core domains for tests) ──────────────
 * Minimal implementations for the compare-and-set tests.
 */

import type { EntityId } from '../../domain/identity.js';
import type { Event } from '../../domain/models/event.js';
import type { Organization, OrganizationMember } from '../../domain/models/organization.js';
import type {
  EventRepository,
  OrganizationRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';

/**
 * Compare-and-set for the memory driver — the same invariant the Firestore
 * adapter enforces (`compare-and-set.ts`): a write of version N must find N-1.
 */
function casSet<T extends { id: EntityId; version: number }>(
  map: Map<EntityId, T>,
  entity: T,
): void {
  const existing = map.get(entity.id);
  if (existing && existing.version !== entity.version - 1) {
    throw new VersionConflictError(entity.version - 1, existing.version);
  }
  map.set(entity.id, entity);
}

/** Serializes a paginated slice of an in-memory array. */
function serializeSlice<T>(all: T[], query: PaginationQuery): Page<T> {
  const { cursor, limit } = query;
  const start = cursor ? all.findIndex((item: any) => item.id === cursor) + 1 : 0;
  const end = Math.min(start + limit, all.length);
  const items = all.slice(start, end);
  const nextCursor = end < all.length && items.length > 0 ? (items[items.length - 1] as any).id : null;
  return { items, total: all.length, nextCursor };
}

export class MemoryEventRepository implements EventRepository {
  events = new Map<EntityId, Event>();

  async getById(eventId: EntityId): Promise<Event | null> {
    return this.events.get(eventId) ?? null;
  }

  async findById(eventId: EntityId): Promise<Event | null> {
    return this.getById(eventId);
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
    casSet(this.events, event);
  }

  async delete(eventId: EntityId, _tx?: TxContext | null): Promise<void> {
    this.events.delete(eventId);
  }
}

export class MemoryOrganizationRepository implements OrganizationRepository {
  organizations = new Map<EntityId, Organization>();
  members = new Map<string, OrganizationMember>(); // key: `${orgId}|${userId}`

  async getById(organizationId: EntityId): Promise<Organization | null> {
    return this.organizations.get(organizationId) ?? null;
  }

  async listForMember(userId: EntityId, query: PaginationQuery): Promise<Page<Organization>> {
    const all = [...this.organizations.values()].filter((org) =>
      org.members?.some((m) => m.userId === userId),
    );
    return serializeSlice(all, query);
  }

  async listMembers(organizationId: EntityId, query: PaginationQuery): Promise<Page<OrganizationMember>> {
    const all: OrganizationMember[] = [];
    for (const [key, member] of this.members) {
      if (key.startsWith(`${organizationId}|`)) {
        all.push(member);
      }
    }
    return serializeSlice(all, query);
  }

  async getMember(organizationId: EntityId, userId: EntityId): Promise<OrganizationMember | null> {
    return this.members.get(`${organizationId}|${userId}`) ?? null;
  }

  async save(org: Organization, _tx?: TxContext | null): Promise<void> {
    casSet(this.organizations, org);
    for (const member of org.members ?? []) {
      this.members.set(`${org.id}|${member.userId}`, member);
    }
  }

  async delete(organizationId: EntityId, _tx?: TxContext | null): Promise<void> {
    this.organizations.delete(organizationId);
    for (const key of this.members.keys()) {
      if (key.startsWith(`${organizationId}|`)) this.members.delete(key);
    }
  }
}