import type { EntityId } from '../../domain/identity.js';
import type { SocialNotification } from '../../domain/models/social.js';
import type { Page, PaginationQuery, TxContext } from '../../domain/ports/repositories.js';

/**
 * Repository for guest/user social notifications (inbox).
 * Separate from the partner dashboard NotificationRepository.
 */
export interface SocialNotificationRepository {
  create(notification: SocialNotification, _tx?: TxContext | null): Promise<void>;
  createIfAbsent(notification: SocialNotification, _tx?: TxContext | null): Promise<boolean>;
  listForUser(
    userId: EntityId,
    query: PaginationQuery & { unreadOnly?: boolean },
  ): Promise<Page<SocialNotification>>;
  countUnread(userId: EntityId): Promise<number>;
  /** Marks specific notifications as read; returns how many changed. */
  markRead(userId: EntityId, ids: EntityId[], readAt: string): Promise<number>;
  markAllRead(userId: EntityId, readAt: string): Promise<number>;
}
