import { markNotificationRead } from '../../domain/models/notification.js';

import type { EntityId } from '../../domain/identity.js';
import type { Notification } from '../../domain/models/notification.js';
import type {
  NotificationRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';

/**
 * In-memory notification adapter. `entries` is public (`Map` keyed by id) so
 * tests can seed an inbox without going through the service.
 */
export class MemoryNotificationRepository implements NotificationRepository {
  entries = new Map<string, Notification>();

  async create(notification: Notification, _tx?: TxContext | null): Promise<void> {
    this.entries.set(notification.id, notification);
  }

  async save(notification: Notification, _tx?: TxContext | null): Promise<void> {
    this.entries.set(notification.id, notification);
  }

  async getById(notificationId: EntityId): Promise<Notification | null> {
    return this.entries.get(notificationId) ?? null;
  }

  async listByRecipient(
    recipientId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Notification>> {
    return paginate(filterByRecipient(this.entries, recipientId), query);
  }

  async listUnreadByRecipient(
    recipientId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Notification>> {
    const unread = [...this.entries.values()].filter(
      (n) => n.recipientId === recipientId && !n.read,
    );
    return paginate(unread, query);
  }

  async markRead(notificationId: EntityId, nowIso: string): Promise<Notification | null> {
    const current = this.entries.get(notificationId);
    if (!current) return null;
    const updated = markNotificationRead(current, new Date(nowIso));
    this.entries.set(notificationId, updated);
    return updated;
  }

  async markAllRead(recipientId: EntityId, nowIso: string): Promise<number> {
    const now = new Date(nowIso);
    let flipped = 0;
    for (const notification of this.entries.values()) {
      if (notification.recipientId === recipientId && !notification.read) {
        this.entries.set(notification.id, markNotificationRead(notification, now));
        flipped += 1;
      }
    }
    return flipped;
  }

  async countUnread(recipientId: EntityId): Promise<number> {
    let count = 0;
    for (const notification of this.entries.values()) {
      if (notification.recipientId === recipientId && !notification.read) count += 1;
    }
    return count;
  }
}

function filterByRecipient(
  entries: Map<string, Notification>,
  recipientId: EntityId,
): Notification[] {
  return [...entries.values()].filter((n) => n.recipientId === recipientId);
}

/** Newest-first, then offset pagination — same scheme as every list adapter. */
function paginate(all: Notification[], query: PaginationQuery): Page<Notification> {
  const sorted = [...all].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const limit = Math.min(Math.max(query.limit, 1), 100);
  const start = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
  const items = sorted.slice(start, start + limit);
  return {
    items,
    total: sorted.length,
    nextCursor: start + limit < sorted.length ? String(start + limit) : null,
  };
}
