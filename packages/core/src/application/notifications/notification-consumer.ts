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

import { createHash } from 'node:crypto';

import { createNotification } from '../../domain/models/notification.js';

import type { CoreConfig } from '../../config/index.js';
import type { DomainEvent, EventPayloads } from '../../domain/events.js';
import type { NotificationRecipientType } from '../../domain/models/notification.js';
import type {
  NotificationRepository,
  OrderRepository,
  OrganizationRepository,
} from '../../domain/ports/repositories.js';
import type { Logger } from '../../telemetry/logger.js';

export interface NotificationConsumerDeps {
  notifications: NotificationRepository;
  orders: Pick<OrderRepository, 'getById'>;
  organizations: Pick<OrganizationRepository, 'getById'>;
  config: Pick<CoreConfig, 'ids' | 'clock'>;
  logger: Logger;
}

export function createNotificationConsumer(deps: NotificationConsumerDeps) {
  return notificationConsumer;

  async function notificationConsumer(event: DomainEvent): Promise<void> {
    const input = await notificationFor(event, deps.orders, deps.organizations);
    if (input === null) return;

    const notification = createNotification({
      id: input.dedupeKey
        ? stableNotificationId(input.recipientId, input.dedupeKey)
        : deps.config.ids(),
      now: deps.config.clock.now(),
      ...input,
    });
    if (input.dedupeKey) await deps.notifications.createIfAbsent(notification);
    else await deps.notifications.create(notification);
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
async function notificationFor(
  event: DomainEvent,
  orders: Pick<OrderRepository, 'getById'>,
  organizations: Pick<OrganizationRepository, 'getById'>,
): Promise<NotificationForInput | null> {
  switch (event.type) {
    case 'promoter.assignment.invited': {
      const payload = event.payload as EventPayloads['promoter.assignment.invited'];
      return {
        recipientId: payload.promoterId,
        recipientType: 'promoter',
        type: event.type,
        title: 'You have been invited to promote an event',
        body: `Review your assignment for "${payload.eventTitle}".`,
        data: {
          assignmentId: payload.assignmentId,
          eventId: payload.eventId,
          eventTitle: payload.eventTitle,
        },
        dedupeKey: `promoter_assignment:${payload.assignmentId}:${event.type}`,
      };
    }
    case 'promoter.assignment.accepted':
    case 'promoter.assignment.rejected': {
      const payload = event.payload as
        | EventPayloads['promoter.assignment.accepted']
        | EventPayloads['promoter.assignment.rejected'];
      const accepted = event.type.endsWith('.accepted');
      return {
        recipientId: payload.eventOwnerId,
        recipientType: payload.eventOwnerType,
        type: event.type,
        title: accepted ? 'Promoter accepted the invitation' : 'Promoter declined the invitation',
        body: `A Promoter ${accepted ? 'accepted' : 'declined'} the invitation for "${payload.eventTitle}".`,
        data: {
          assignmentId: payload.assignmentId,
          eventId: payload.eventId,
          eventTitle: payload.eventTitle,
        },
        dedupeKey: `promoter_assignment:${payload.assignmentId}:${event.type}`,
      };
    }
    case 'promoter.assignment.revoked': {
      const payload = event.payload as EventPayloads['promoter.assignment.revoked'];
      return {
        recipientId: payload.promoterId,
        recipientType: 'promoter',
        type: event.type,
        title: 'An event assignment was revoked',
        body: `Your assignment for "${payload.eventTitle}" was revoked.`,
        data: {
          assignmentId: payload.assignmentId,
          eventId: payload.eventId,
          eventTitle: payload.eventTitle,
        },
        dedupeKey: `promoter_assignment:${payload.assignmentId}:${event.type}`,
      };
    }
    case 'promoter.assignment.expired': {
      const payload = event.payload as EventPayloads['promoter.assignment.expired'];
      const promoter = await organizations.getById(payload.promoterId);
      if (!promoter?.members.some((member) => member.capabilities.includes('promoter')))
        return null;
      return {
        recipientId: payload.promoterId,
        recipientType: 'promoter',
        type: event.type,
        title: 'A Promoter assignment expired',
        body: payload.eventTitle
          ? `Your assignment for "${payload.eventTitle}" has expired.`
          : 'One of your event assignments has expired.',
        data: {
          assignmentId: payload.assignmentId,
          eventId: payload.eventId,
          eventTitle: payload.eventTitle,
          expiresAt: payload.expiresAt,
        },
        dedupeKey: `promoter_assignment:${payload.assignmentId}:expired:${payload.expiresAt}`,
      };
    }
    case 'promoter.campaign.activated':
    case 'promoter.campaign.revoked': {
      const payload = event.payload as
        EventPayloads['promoter.campaign.activated'] | EventPayloads['promoter.campaign.revoked'];
      const activated = event.type.endsWith('.activated');
      return {
        recipientId: payload.promoterId,
        recipientType: 'promoter',
        type: event.type,
        title: activated ? 'Your event campaign is active' : 'An event campaign was deactivated',
        body: activated
          ? `Your tracking link for "${payload.eventTitle}" is ready to share.`
          : `Your tracking link for "${payload.eventTitle}" is no longer active.`,
        data: {
          referralLinkId: payload.referralLinkId,
          eventId: payload.eventId,
          eventTitle: payload.eventTitle,
        },
        dedupeKey: `promoter_campaign:${payload.referralLinkId}:${event.type}`,
      };
    }
    case 'promoter.onboarding.approved': {
      const payload = event.payload as EventPayloads['promoter.onboarding.approved'];
      return {
        recipientId: payload.promoterId,
        recipientType: 'promoter',
        type: event.type,
        title: 'Your Promoter application was approved',
        body: 'Your Promoter organization is ready. Review the current agreement before starting a campaign.',
        data: { requestId: payload.requestId },
        dedupeKey: `promoter_onboarding:${payload.requestId}:approved`,
      };
    }
    case 'promoter.assignments.status_changed': {
      const payload = event.payload as EventPayloads['promoter.assignments.status_changed'];
      const suspended = payload.status === 'suspended';
      return {
        recipientId: payload.promoterId,
        recipientType: 'promoter',
        type: event.type,
        title: suspended
          ? 'Your event assignments were suspended'
          : 'Your event assignments were reinstated',
        body: `${payload.affectedAssignments} event assignment${payload.affectedAssignments === 1 ? '' : 's'} ${suspended ? 'were paused' : 'are active again'}.`,
        data: { status: payload.status, affectedAssignments: payload.affectedAssignments },
        dedupeKey: `promoter_assignments:${payload.promoterId}:${payload.status}:${event.id}`,
      };
    }
    case 'order.fulfilled': {
      const payload = event.payload as EventPayloads['order.fulfilled'];
      const order = await orders.getById(payload.orderId);
      const attribution = order?.attribution;
      if (
        !order ||
        order.status !== 'paid' ||
        !attribution ||
        attribution.promoterCommissionPaise <= 0
      ) {
        return null;
      }
      return {
        recipientId: attribution.promoterId,
        recipientType: 'promoter',
        type: 'promoter.attributed_sale',
        title: 'An attributed booking was fulfilled',
        body: `Frozen commission: ${money(attribution.promoterCommissionPaise)}.`,
        data: {
          eventId: order.eventId,
          orderId: order.id,
          bookingReference: order.bookingReference ?? null,
          commissionPaise: attribution.promoterCommissionPaise,
        },
        dedupeKey: `promoter_sale:${order.id}`,
      };
    }
    case 'finance.refund.settled': {
      const payload = event.payload as EventPayloads['finance.refund.settled'];
      const order = await orders.getById(payload.orderId);
      const attribution = order?.attribution;
      if (!order || !attribution || attribution.promoterCommissionPaise <= 0) return null;
      return {
        recipientId: attribution.promoterId,
        recipientType: 'promoter',
        type: 'promoter.commission_refund',
        title: 'A refund changed attributed commission',
        body: 'A settled refund changed commission for one of your attributed bookings.',
        data: {
          eventId: order.eventId,
          orderId: order.id,
          refundRequestId: payload.refundRequestId,
          refundAmountPaise: payload.amountPaise,
          bookingReference: order.bookingReference ?? null,
        },
        dedupeKey: `promoter_refund:${payload.refundRequestId}`,
      };
    }
    case 'finance.chargeback.updated': {
      const payload = event.payload as EventPayloads['finance.chargeback.updated'];
      const order = await orders.getById(payload.orderId);
      const attribution = order?.attribution;
      if (!order || !attribution || attribution.promoterCommissionPaise <= 0) return null;
      const holdActive = payload.status === 'open' || payload.status === 'under_review';
      return {
        recipientId: attribution.promoterId,
        recipientType: 'promoter',
        type: holdActive ? 'promoter.chargeback_hold' : 'promoter.commission_chargeback',
        title: holdActive
          ? 'Commission is temporarily held during a payment dispute'
          : 'A payment dispute changed attributed commission',
        body: holdActive
          ? 'A payment dispute opened on an attributed booking. Its commission is held while the dispute is reviewed.'
          : `The payment dispute status is ${payload.status.replaceAll('_', ' ')}. Review the commission activity for this booking.`,
        data: {
          eventId: order.eventId,
          orderId: order.id,
          disputeId: payload.disputeId,
          disputeStatus: payload.status,
          bookingReference: order.bookingReference ?? null,
        },
        dedupeKey: `promoter_chargeback:${payload.disputeId}:${payload.status}`,
      };
    }
    case 'finance.payout.status_changed': {
      const payload = event.payload as EventPayloads['finance.payout.status_changed'];
      const organization = await organizations.getById(payload.organizationId);
      if (!organization?.members.some((member) => member.capabilities.includes('promoter'))) {
        return null;
      }
      return {
        recipientId: payload.organizationId,
        recipientType: 'promoter',
        type: 'promoter.commission_payout',
        title: `Promoter payout ${payload.status.replaceAll('_', ' ')}`,
        body: `Payout status changed to ${payload.status.replaceAll('_', ' ')} for ${money(payload.amountPaise)}.`,
        data: {
          payoutId: payload.payoutId,
          payoutStatus: payload.status,
          amountPaise: payload.amountPaise,
        },
        dedupeKey: `promoter_payout:${payload.payoutId}:${payload.version}`,
      };
    }
    case 'promoter_connection.requested': {
      const payload = event.payload as EventPayloads['promoter_connection.requested'];
      // The recipient is whichever side did NOT open the conversation — the
      // same rule as `recipientOf` in the domain model. When the promoter
      // opened it the target answers; when a venue/host invited a promoter the
      // PROMOTER answers, and `targetId` would address the initiator itself.
      const promoterOpened = payload.initiatedBy === 'promoter';
      return {
        recipientId: promoterOpened ? payload.targetId : payload.promoterId,
        recipientType: promoterOpened ? payload.targetType : 'promoter',
        type: event.type,
        title: promoterOpened
          ? `${payload.promoterName} wants to connect`
          : `${payload.targetName} wants to connect with you`,
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

function stableNotificationId(recipientId: string, dedupeKey: string): string {
  const digest = createHash('sha256').update(`${recipientId}:${dedupeKey}`).digest('hex');
  return `NTF-${digest.slice(0, 40)}`;
}

function money(amountPaise: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(
    amountPaise / 100,
  );
}
