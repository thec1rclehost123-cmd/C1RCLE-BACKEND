import { currentEntitlementHolderId } from '../../domain/models/entitlement.js';
import { createNotification, eventMaterialChangeSubjectId } from '../../domain/models/social.js';

import type { CoreConfig } from '../../config/index.js';
import type { DomainEvent } from '../../domain/events.js';
import type { EntityId } from '../../domain/identity.js';
import type { FollowTargetType } from '../../domain/models/social.js';
import type {
  EventRepository,
  FollowRepository,
  EntitlementRepository,
  OrderRepository,
  SocialNotificationRepository,
} from '../../domain/ports/repositories.js';

/**
 * ─── Phase 8 bus subscribers ────────────────────────────────────────────────
 * v1's `notifyNewEvent()` ran inline in the publish request. Here it is a
 * subscriber on `event.published`: the publisher (EventService) knows nothing
 * about followers, and this consumer can be moved to a durable queue worker
 * (B12) without touching the publish path.
 *
 * Delivery is at-least-once, so the consumer is idempotent end to end:
 *  - it re-reads the event, so a stale redelivery (event since cancelled)
 *    notifies nobody;
 *  - notification ids are deterministic per (recipient, type, event) and
 *    written with `createIfAbsent`, so a retry, a `resumeSales` re-publish, or
 *    a follower of both the venue and its host all converge on one row;
 *  - `createdAt` comes from the event's `occurredAt`, not wall clock.
 * A thrown error leaves the outbox row pending for the bus to retry / DLQ.
 */

const FOLLOWER_PAGE_SIZE = 100;
const WRITE_CONCURRENCY = 50;

export interface FollowerFanOutDeps {
  events: Pick<EventRepository, 'getById'>;
  follows: Pick<FollowRepository, 'listFollowers'>;
  notifications: Pick<SocialNotificationRepository, 'createIfAbsent'>;
}

export function createFollowerFanOutConsumer(deps: FollowerFanOutDeps) {
  // Named so the bus's per-handler dedupe key is readable in logs.
  return async function notifyFollowersOfPublishedEvent(domainEvent: DomainEvent) {
    const event = await deps.events.getById(domainEvent.aggregateId);
    if (!event || event.status !== 'published') return;

    // Venue first: a guest following both gets the more specific reason.
    const reasons = new Map<EntityId, FollowTargetType>();
    const targets: [FollowTargetType, EntityId | null][] = [
      ['venue', event.venueId],
      ['host', event.organizationId],
    ];
    for (const [targetType, targetId] of targets) {
      if (!targetId) continue;
      for await (const followerId of followerIds(deps.follows, targetType, targetId)) {
        if (!reasons.has(followerId)) reasons.set(followerId, targetType);
      }
    }

    const now = new Date(domainEvent.occurredAt);
    const recipients = [...reasons];
    for (let i = 0; i < recipients.length; i += WRITE_CONCURRENCY) {
      await Promise.all(
        recipients.slice(i, i + WRITE_CONCURRENCY).map(([userId, reason]) =>
          deps.notifications.createIfAbsent(
            createNotification({
              userId,
              type: 'event.new_from_followed',
              title: `New event: ${event.title}`,
              body:
                reason === 'venue'
                  ? 'A venue you follow just published a new event.'
                  : 'A host you follow just published a new event.',
              link: `/event/${event.slug}`,
              subjectId: event.id,
              now,
            }),
          ),
        ),
      );
    }
  };
}

export interface EventMaterialChangeNoticeDeps {
  orders: Pick<OrderRepository, 'getById'>;
  entitlements: Pick<EntitlementRepository, 'getById'>;
  notifications: Pick<SocialNotificationRepository, 'createIfAbsent'>;
  config: Pick<CoreConfig, 'clock'>;
}

/**
 * Creates durable, user-scoped inbox notices for material event changes.
 * Reading the notice is only an acknowledgement of receipt; it does not
 * represent consent to the change or waive any refund/remedy rights.
 */
export function createEventMaterialChangeNoticeConsumer(deps: EventMaterialChangeNoticeDeps) {
  return async function notifyTicketOwnersOfMaterialEventChange(domainEvent: DomainEvent) {
    if (domainEvent.type !== 'event.material_change.order_affected') return;
    const payload = domainEvent.payload as {
      eventId: EntityId;
      orderId: EntityId;
      entitlementId?: EntityId | null;
      eventVersion: number;
      previousTitle: string;
      title: string;
      previousStartAt: string;
      startAt: string;
    };
    if (
      !Number.isSafeInteger(payload.eventVersion) ||
      payload.eventVersion < 1 ||
      !payload.entitlementId
    )
      return;
    const eventVersion = payload.eventVersion;
    const entitlementId = payload.entitlementId;
    const order = await deps.orders.getById(payload.orderId);
    if (
      !order ||
      order.eventId !== payload.eventId ||
      !['paid', 'refund_requested'].includes(order.status)
    ) {
      return;
    }

    const recipients = new Map<EntityId, { canAccept: boolean; canRequestRefund: boolean }>();
    if (order.userId) recipients.set(order.userId, { canAccept: false, canRequestRefund: true });
    const entitlement = await deps.entitlements.getById(entitlementId);
    if (
      !entitlement ||
      entitlement.orderId !== order.id ||
      entitlement.eventId !== payload.eventId ||
      entitlement.status === 'void'
    ) {
      return;
    }
    const holderId = currentEntitlementHolderId(entitlement);
    if (holderId) {
      const current = recipients.get(holderId);
      recipients.set(holderId, {
        canAccept: true,
        canRequestRefund: current?.canRequestRefund ?? false,
      });
    }
    if (recipients.size === 0) return;

    const subjectId = eventMaterialChangeSubjectId(
      payload.eventId,
      eventVersion,
      order.id,
      entitlementId,
    );
    const title =
      payload.previousTitle === payload.title
        ? 'Event details changed'
        : `Event update: ${payload.title}`;
    const body = `${payload.previousTitle} was updated. Review the current date, time and venue in your ticket wallet. This notice does not change your ticket or refund rights.`;

    await Promise.all(
      [...recipients].map(([userId, actions]) =>
        deps.notifications.createIfAbsent(
          createNotification({
            userId,
            type: 'event.material_change',
            title,
            body,
            link: '/tickets',
            subjectId,
            eventChange: {
              eventVersion,
              entitlementId,
              ...actions,
            },
            now: new Date(domainEvent.occurredAt || deps.config.clock.now().getTime()),
          }),
        ),
      ),
    );
  };
}

async function* followerIds(
  follows: FollowerFanOutDeps['follows'],
  targetType: FollowTargetType,
  targetId: EntityId,
): AsyncGenerator<EntityId> {
  let cursor: string | null = null;
  do {
    const page = await follows.listFollowers(targetType, targetId, {
      cursor,
      limit: FOLLOWER_PAGE_SIZE,
    });
    for (const follow of page.items) yield follow.followerId;
    cursor = page.nextCursor;
  } while (cursor !== null);
}
