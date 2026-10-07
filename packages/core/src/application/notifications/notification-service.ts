import { InvalidOperationError, NotificationNotFoundError } from '../../domain/errors.js';
import { createNotification } from '../../domain/models/notification.js';
import { requireOrgAccess } from '../context.js';
import { PartnershipService } from '../partnerships/partnership-service.js';
import { PromoterConnectionService } from '../promoters/promoter-connection-service.js';
import { VenueSlotRequestService } from '../venues/venue-service.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  Notification,
  NotificationActionType,
  NotificationPriority,
  NotificationRecipientType,
} from '../../domain/models/notification.js';
import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * ─── Notification service (V2 partner inbox) ─────────────────────────────────
 * Addresses notifications to ORGANIZATIONS (the tenant), so every read and
 * mutation is a single one-line tenancy check (`requireOrgAccess` /
 * recipient match) and no peer/service duplication. Quick actions delegate to
 * the owning services (`PromoterConnectionService` / `PartnershipService` /
 * `VenueSlotRequestService`) — all their receipt/party rules stay in one
 * place; this layer only routes a notification's `action` to the right one
 * and marks it read on success.
 */

export interface RecordNotificationInput {
  recipientId: EntityId;
  recipientType: NotificationRecipientType;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  action?: { resourceType: NotificationActionType; resourceId: EntityId };
  priority?: NotificationPriority;
  dedupeKey?: string;
}

export interface NotificationListResult extends Page<Notification> {
  unreadCount: number;
}

export type NotificationDecision = 'approve' | 'reject';

export class NotificationService {
  constructor(private deps: ServiceDeps) {}

  private get repo() {
    return this.deps.repositories.notifications;
  }

  /**
   * Producer entrypoint used by the event-bus consumer. Id + clock come from
   * the injected config, so the write is fully deterministic under test.
   */
  async record(input: RecordNotificationInput): Promise<Notification> {
    const notification = createNotification({
      id: this.deps.config.ids(),
      now: this.deps.config.clock.now(),
      ...input,
    });
    await this.repo.create(notification);
    this.deps.logger.info('notification.recorded', {
      notificationId: notification.id,
      recipientId: notification.recipientId,
      type: notification.type,
    });
    return notification;
  }

  /** Inbox page plus a live unread count for the bell badge, in one round trip. */
  async list(
    actor: ActorContext,
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<NotificationListResult> {
    requireOrgAccess(actor, organizationId);
    const [page, unreadCount] = await Promise.all([
      this.repo.listByRecipient(organizationId, query),
      this.repo.countUnread(organizationId),
    ]);
    return { ...page, unreadCount };
  }

  async listUnread(
    actor: ActorContext,
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Notification>> {
    requireOrgAccess(actor, organizationId);
    return this.repo.listUnreadByRecipient(organizationId, query);
  }

  /** Single-read ownership check (v1 precedent): a foreign row reads as not-found. */
  async markRead(actor: ActorContext, notificationId: EntityId): Promise<Notification> {
    const notification = await this.owned(actor, notificationId);
    if (notification.read) return notification;
    const updated = await this.repo.markRead(
      notificationId,
      this.deps.config.clock.now().toISOString(),
    );
    return updated ?? notification;
  }

  async markAllRead(actor: ActorContext, organizationId: EntityId): Promise<number> {
    requireOrgAccess(actor, organizationId);
    return this.repo.markAllRead(organizationId, this.deps.config.clock.now().toISOString());
  }

  /**
   * Runs the notification's quick action (approve/reject) through the domain
   * service that owns that resource, then marks the notification read. The
   * resource services enforce their own receipt/party rules against the
   * actor, so a stale notification for a resource the actor no longer answers
   * surfaces that service's domain error, not a fabricated one here.
   */
  async performAction(
    actor: ActorContext,
    notificationId: EntityId,
    decision: NotificationDecision,
  ): Promise<Notification> {
    const notification = await this.owned(actor, notificationId);
    if (!notification.action) {
      throw new InvalidOperationError('This notification has no quick action');
    }
    const { resourceType, resourceId } = notification.action;

    switch (resourceType) {
      case 'promoter_connection': {
        const connections = new PromoterConnectionService(this.deps);
        if (decision === 'approve') await connections.approve(actor, resourceId);
        else await connections.reject(actor, resourceId);
        break;
      }
      case 'partnership': {
        const partnerships = new PartnershipService(this.deps);
        if (decision === 'approve') await partnerships.approve(actor, resourceId);
        else await partnerships.reject(actor, resourceId);
        break;
      }
      case 'slot_request': {
        const slotRequests = new VenueSlotRequestService(this.deps);
        if (decision === 'approve') await slotRequests.accept(actor, resourceId);
        else await slotRequests.reject(actor, resourceId);
        break;
      }
      default:
        throw new InvalidOperationError(`Unsupported notification action: ${resourceType}`);
    }

    const marked = await this.repo.markRead(
      notificationId,
      this.deps.config.clock.now().toISOString(),
    );
    return marked ?? notification;
  }

  /** Loads a notification the actor's org owns; a foreign row reads not-found. */
  private async owned(actor: ActorContext, notificationId: EntityId): Promise<Notification> {
    const notification = await this.repo.getById(notificationId);
    if (!notification || notification.recipientId !== actor.organizationId) {
      throw new NotificationNotFoundError(notificationId);
    }
    return notification;
  }
}
