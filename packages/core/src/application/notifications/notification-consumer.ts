/**
 * ─── Notification producer consumer ──────────────────────────────────────────
 * Domain events → inbox rows. This is the counterpart to the v1 producers
 * ("connection requested", "partnership requested", "event published") and
 * lives on the event bus because the emitting services must not know about
 * notifications: a service writes its aggregate and emits; this consumer turns
 * that event into the recipient's inbox entry. The bus's per-handler event-id
 * dedupe makes re-delivery idempotent.
 *
 * The handler is a NAMED function on purpose — the bus keys its dedupe set by
 * `handler.name`, so an anonymous arrow would collapse every subscription
 * into one shared "seen" set and one consumer could silence another.
 */

import { createNotification } from '../../domain/models/notification.js';

import type { CoreConfig } from '../../config/index.js';
import type { DomainEvent, EventPayloads } from '../../domain/events.js';
import type { NotificationRecipientType } from '../../domain/models/notification.js';
import type { NotificationRepository } from '../../domain/ports/repositories.js';
import type { Logger } from '../../telemetry/logger.js';

export interface NotificationConsumerDeps {
  notifications: NotificationRepository;
  config: Pick<CoreConfig, 'ids' | 'clock'>;
  logger: Logger;
}

export function createNotificationConsumer(deps: NotificationConsumerDeps) {
  return notificationConsumer;

  async function notificationConsumer(event: DomainEvent): Promise<void> {
    const input = notificationFor(event);
    if (input === null) return;

    const notification = createNotification({
      id: deps.config.ids(),
      now: deps.config.clock.now(),
      ...input,
    });
    await deps.notifications.create(notification);
    deps.logger.info('notification.recorded', {
      notificationId: notification.id,
      recipientId: notification.recipientId,
      type: notification.type,
    });
  }
}

interface NotificationForInput {
  recipientId: string;
  recipientType: NotificationRecipientType;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  action?: {
    resourceType: 'promoter_connection' | 'partnership' | 'slot_request';
    resourceId: string;
  };
  dedupeKey?: string;
}

/**
 * Maps an event to its inbox row. The recipient is always the OTHER party as
 * far as the event emitter is concerned — never the event's own
 * `organizationId` (the requester/publisher's org), except `event.published`,
 * whose event *belongs* to the venue org notified.
 */
function notificationFor(event: DomainEvent): NotificationForInput | null {
  switch (event.type) {
    case 'promoter_connection.requested': {
      const payload = event.payload as EventPayloads['promoter_connection.requested'];
      return {
        recipientId: payload.targetId,
        recipientType: payload.targetType,
        type: event.type,
        title: `${payload.promoterName} wants to connect`,
        body: payload.message ?? 'A new promoter connection request is waiting for your review.',
        action: { resourceType: 'promoter_connection', resourceId: payload.connectionId },
        dedupeKey: `connection:${payload.connectionId}`,
      };
    }
    case 'partnership.requested': {
      const payload = event.payload as EventPayloads['partnership.requested'];
      const recipientIsVenue = payload.initiatedBy === 'host';
      return {
        recipientId: recipientIsVenue ? payload.venueOrganizationId : payload.hostOrganizationId,
        recipientType: recipientIsVenue ? 'venue' : 'host',
        type: event.type,
        title: recipientIsVenue
          ? `${payload.hostName} wants to partner with your venue`
          : `${payload.venueName} is inviting you to partner`,
        body: 'Approve or decline the partnership request.',
        action: { resourceType: 'partnership', resourceId: payload.partnershipId },
        dedupeKey: `partnership:${payload.partnershipId}`,
      };
    }
    case 'event.published': {
      const payload = event.payload as EventPayloads['event.published'];
      return {
        // The event's org IS the organising venue org in V2 — the event is
        // owned by the venue tenant, so the inbox entry lands in its own
        // workspace as a confirmation, no venue-resolve needed.
        recipientId: event.organizationId,
        recipientType: 'venue',
        type: event.type,
        title: `"${payload.title}" is live`,
        body: 'Your event has been published and is visible to guests.',
        dedupeKey: `event_published:${event.aggregateId}`,
      };
    }
    default:
      return null;
  }
}
