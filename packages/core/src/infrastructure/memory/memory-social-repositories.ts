import type { EntityId } from '../../domain/identity.js';
import type { Follow, FollowTargetType, Notification } from '../../domain/models/social.js';
import type {
  FollowRepository,
  SocialNotificationRepository,
  Page,
  PaginationQuery,
} from '../../domain/ports/repositories.js';

/** Same offset-cursor scheme as `firestore/pagination.ts` (adapter parity). */
function page<TItem>(all: TItem[], query: PaginationQuery): Page<TItem> {
  const limit = Math.min(Math.max(query.limit, 1), 100);
  const start = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
  const items = all.slice(start, start + limit);
  const nextCursor = start + limit < all.length ? String(start + limit) : null;
  return { items, total: all.length, nextCursor };
}

const newestFirst = <T extends { createdAt: string; id: string }>(a: T, b: T) =>
  b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

export class MemoryFollowRepository implements FollowRepository {
  entries = new Map<EntityId, Follow>();

  async get(id: EntityId): Promise<Follow | null> {
    return this.entries.get(id) ?? null;
  }

  async save(follow: Follow): Promise<void> {
    this.entries.set(follow.id, follow);
  }

  async delete(id: EntityId): Promise<boolean> {
    return this.entries.delete(id);
  }

  async listByFollower(
    followerId: EntityId,
    query: PaginationQuery & { targetType?: FollowTargetType },
  ): Promise<Page<Follow>> {
    const all = [...this.entries.values()]
      .filter(
        (f) =>
          f.followerId === followerId &&
          (query.targetType === undefined || f.targetType === query.targetType),
      )
      .sort(newestFirst);
    return page(all, query);
  }

  async listFollowers(
    targetType: FollowTargetType,
    targetId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Follow>> {
    const all = [...this.entries.values()]
      .filter((f) => f.targetType === targetType && f.targetId === targetId)
      .sort(newestFirst);
    return page(all, query);
  }

  async countFollowers(targetType: FollowTargetType, targetId: EntityId): Promise<number> {
    let count = 0;
    for (const f of this.entries.values()) {
      if (f.targetType === targetType && f.targetId === targetId) count += 1;
    }
    return count;
  }
}

export class MemorySocialNotificationRepository implements SocialNotificationRepository {
  entries = new Map<EntityId, Notification>();

  async createIfAbsent(notification: Notification): Promise<boolean> {
    if (this.entries.has(notification.id)) return false;
    this.entries.set(notification.id, notification);
    return true;
  }

  async listForUser(
    userId: EntityId,
    query: PaginationQuery & { unreadOnly?: boolean },
  ): Promise<Page<Notification>> {
    const all = [...this.entries.values()]
      .filter((n) => n.userId === userId && (!query.unreadOnly || n.readAt === null))
      .sort(newestFirst);
    return page(all, query);
  }

  async countUnread(userId: EntityId): Promise<number> {
    let count = 0;
    for (const n of this.entries.values()) {
      if (n.userId === userId && n.readAt === null) count += 1;
    }
    return count;
  }

  async markRead(userId: EntityId, ids: EntityId[], readAt: string): Promise<number> {
    let updated = 0;
    for (const id of new Set(ids)) {
      const n = this.entries.get(id);
      if (!n || n.userId !== userId || n.readAt !== null) continue;
      this.entries.set(id, { ...n, readAt });
      updated += 1;
    }
    return updated;
  }

  async markAllRead(userId: EntityId, readAt: string): Promise<number> {
    const ids = [...this.entries.values()]
      .filter((n) => n.userId === userId && n.readAt === null)
      .map((n) => n.id);
    return this.markRead(userId, ids, readAt);
  }
}
