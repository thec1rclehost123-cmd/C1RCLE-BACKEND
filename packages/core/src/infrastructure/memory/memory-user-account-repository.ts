import type { EntityId } from '../../domain/identity.js';
import type { PlatformUser } from '../../domain/models/platform-user.js';
import type {
  Page,
  PaginationQuery,
  UserAccountRepository,
} from '../../domain/ports/repositories.js';

/** Offset-style slice helper matching the shared memory pagination scheme. */
function serializeSlice<TItem>(all: TItem[], query: PaginationQuery): Page<TItem> {
  const limit = Math.min(Math.max(query.limit, 1), 100);
  const start = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
  const items = all.slice(start, start + limit);
  const nextCursor = start + limit < all.length ? String(start + limit) : null;
  return { items, total: all.length, nextCursor };
}

/**
 * In-memory adapter for `UserAccountRepository`. READ-ONLY default (empty
 * seed); tests seed accounts via `save(...)` before hitting the admin routes.
 */
export class MemoryUserAccountRepository implements UserAccountRepository {
  users = new Map<EntityId, PlatformUser>();

  save(user: PlatformUser): void {
    this.users.set(user.id, user);
  }

  async listAll(query: PaginationQuery): Promise<Page<PlatformUser>> {
    return serializeSlice([...this.users.values()], query);
  }

  async getById(userId: EntityId): Promise<PlatformUser | null> {
    return this.users.get(userId) ?? null;
  }
}
