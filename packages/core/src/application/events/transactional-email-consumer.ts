import { createHash } from 'node:crypto';

import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import { currentEntitlementHolderId } from '../../domain/models/entitlement.js';
import { PermanentEmailDeliveryError } from '../../domain/ports/email-sender.js';

import type { DomainEvent, EventPayloads } from '../../domain/events.js';
import type { EntityId } from '../../domain/identity.js';
import type { Order } from '../../domain/models/order.js';
import type { ServiceDeps } from '../context.js';

const LEASE_MS = 60_000;
type MaterialChangeBatch = EventPayloads['event.material_change.batch_requested'];
type MaterialChange = Omit<MaterialChangeBatch, 'cursor' | 'eventId'>;

/** Outbox subscriber for order/refund/cancellation messages. */
export function createTransactionalEmailConsumer(deps: ServiceDeps) {
  return async (event: DomainEvent): Promise<void> => {
    if (event.type === 'event.updated' || event.type === 'event.material_change.batch_requested') {
      await enqueueMaterialChangeRecipients(event, deps);
      return;
    }
    const message = await buildMessage(event, deps);
    if (!message) return;
    const id = `MAIL-${createHash('sha256').update(message.idempotencyKey).digest('hex').slice(0, 40)}`;
    const recipientHash = createHash('sha256')
      .update(message.to.trim().toLowerCase())
      .digest('hex');
    const now = deps.config.clock.now().getTime();
    await deps.emailDeliveries.createIfAbsent({
      id,
      aggregateId: message.aggregateId,
      kind: message.kind,
      status: 'queued',
      recipientHash,
      retryCount: 0,
      providerMessageId: null,
      createdAt: now,
      updatedAt: now,
      sentAt: null,
      lastError: null,
      leaseExpiresAt: null,
    });
    if (!(await deps.emailDeliveries.claim(id, now, now + LEASE_MS))) return;
    try {
      if (!deps.emailSender.sendTransactionalEmail)
        throw new Error('Transactional email sender unavailable');
      const result = await deps.emailSender.sendTransactionalEmail(message);
      await deps.emailDeliveries.markSent(
        id,
        result.providerMessageId,
        deps.config.clock.now().getTime(),
      );
    } catch (error) {
      // Provider errors can contain request/recipient data. Keep only a safe
      // category in durable evidence and let the outbox apply its retry policy.
      await deps.emailDeliveries.markFailed(
        id,
        'Transactional email provider failure',
        deps.config.clock.now().getTime(),
      );
      if (error instanceof PermanentEmailDeliveryError) return;
      throw new Error('Transactional email delivery failed');
    }
  };
}

async function buildMessage(event: DomainEvent, deps: ServiceDeps) {
  let order: Order | null = null;
  let idempotencyKey = '';
  let kind = '';
  let subject = '';
  let heading = '';
  let details = '';
  let explicitRecipient: string | null = null;
  let deliveryAggregateId: EntityId = event.aggregateId;

  if (event.type === 'order.fulfilled') {
    const { orderId } = event.payload as { orderId: EntityId };
    order = await deps.repositories.orders.getById(orderId);
    if (!order || order.status !== 'paid') return null;
    if (!isDeliverableRecipient(order.contact.email)) return null;
    const isRsvp = order.grandTotalPaise === 0;
    kind = isRsvp ? 'rsvp_confirmation' : 'booking_receipt';
    idempotencyKey = `${isRsvp ? 'rsvp-confirmation' : 'booking-receipt'}:${order.id}:fulfilled`;
    subject = isRsvp ? 'Your C1RCLE RSVP is confirmed' : 'Your C1RCLE booking is confirmed';
    heading = isRsvp ? 'RSVP confirmed' : 'Booking confirmed';
    details = await receiptDetails(order, deps);
  } else if (
    event.type === 'ticket.transfer.created' ||
    event.type === 'ticket.transfer.invitation_resent'
  ) {
    const payload = event.payload as { transferId: EntityId; deliveryRequestId?: string };
    const transfer = await deps.repositories.entitlements.getTicketTransfer(payload.transferId);
    if (
      !transfer ||
      transfer.status !== 'pending' ||
      !transfer.recipientUserId ||
      Date.parse(transfer.expiresAt) <= deps.config.clock.now().getTime()
    ) {
      return null;
    }
    const recipient = await deps.repositories.users.getById(transfer.recipientUserId);
    if (
      !recipient?.emailVerified ||
      !isDeliverableRecipient(recipient.email) ||
      (transfer.recipientEmailHash &&
        createHash('sha256').update(recipient.email.trim().toLowerCase()).digest('hex') !==
          transfer.recipientEmailHash)
    ) {
      return null;
    }
    const entitlement = await deps.repositories.entitlements.getById(transfer.entitlementId);
    const eventRecord = entitlement
      ? await deps.repositories.events.getById(entitlement.eventId)
      : null;
    if (
      !entitlement ||
      !eventRecord ||
      entitlement.status !== 'valid' ||
      entitlement.pendingTransferId !== transfer.id ||
      currentEntitlementHolderId(entitlement) !== transfer.senderUserId
    ) {
      return null;
    }
    if (deps.emailSender.name === 'logging' || !deps.emailSender.sendTransactionalEmail)
      return null;
    explicitRecipient = recipient.email;
    deliveryAggregateId = transfer.id;
    kind = 'ticket_transfer_invitation';
    idempotencyKey = payload.deliveryRequestId
      ? `ticket-transfer-invitation:${transfer.id}:${payload.deliveryRequestId}`
      : `ticket-transfer-invitation:${transfer.id}`;
    subject = 'A C1RCLE ticket is waiting for you';
    heading = 'You have a ticket invitation';
    const transferUrl = `https://thec1rcle.com/ticket-transfer/${encodeURIComponent(transfer.id)}`;
    details = `<p>A ticket for <strong>${escapeHtml(eventRecord.title)}</strong> is waiting in your C1RCLE account.</p><p><a href="${transferUrl}" style="color:#ff5a00">Review this invitation</a></p><p>Sign in with the verified email address this invitation was sent to. Your ticket holder will change only after you accept.</p>`;
  } else if (event.type === 'ticket.issued' || event.type === 'ticket.transfer.resolved') {
    const payload = event.payload as {
      entitlementId: EntityId;
      eventId: EntityId;
      purchaserUserId?: EntityId | null;
      holderUserId?: EntityId | null;
      transferId?: EntityId;
      status?: string;
      credentialVersion?: number;
      upgradeFromEntitlementId?: EntityId;
    };
    const isUpgradeIssuance =
      event.type === 'ticket.issued' && Boolean(payload.upgradeFromEntitlementId);
    if (event.type === 'ticket.transfer.resolved' && payload.status === 'expired') {
      if (!payload.transferId) return null;
      const transfer = await deps.repositories.entitlements.getTicketTransfer(payload.transferId);
      if (
        !transfer ||
        transfer.status !== 'expired' ||
        transfer.entitlementId !== payload.entitlementId ||
        transfer.eventId !== payload.eventId
      ) {
        return null;
      }
      const sender = await deps.repositories.users.getById(transfer.senderUserId);
      if (
        !sender?.emailVerified ||
        !isDeliverableRecipient(sender.email) ||
        deps.emailSender.name === 'logging' ||
        !deps.emailSender.sendTransactionalEmail
      ) {
        return null;
      }
      const eventRecord = await deps.repositories.events.getById(transfer.eventId);
      if (!eventRecord) return null;
      explicitRecipient = sender.email;
      deliveryAggregateId = transfer.id;
      kind = 'ticket_transfer_expired';
      idempotencyKey = `ticket-transfer-expired:${transfer.id}:${transfer.resolvedAt ?? transfer.version}`;
      subject = 'Your C1RCLE ticket invitation expired';
      heading = 'Ticket invitation expired';
      details = `<p>The ticket invitation for <strong>${escapeHtml(eventRecord.title)}</strong> expired before it was accepted.</p><p>The ticket remains in your account. You can send a new invitation if you still want to transfer it.</p>`;
    } else {
      if (event.type === 'ticket.transfer.resolved' && payload.status !== 'accepted') return null;
      if (
        event.type === 'ticket.transfer.resolved' &&
        (!payload.transferId || !Number.isSafeInteger(payload.credentialVersion))
      ) {
        return null;
      }
      const entitlement = await deps.repositories.entitlements.getById(payload.entitlementId);
      if (!entitlement || entitlement.status === 'void') return null;
      const currentHolderUserId = entitlement.currentHolderUserId ?? entitlement.userId;
      if (!currentHolderUserId) return null;
      if (
        event.type === 'ticket.issued' &&
        !isUpgradeIssuance &&
        (currentHolderUserId !== payload.holderUserId ||
          currentHolderUserId === (payload.purchaserUserId ?? null))
      ) {
        return null;
      }
      if (
        isUpgradeIssuance &&
        entitlement.upgradeFromEntitlementId !== payload.upgradeFromEntitlementId
      ) {
        return null;
      }
      if (
        event.type === 'ticket.transfer.resolved' &&
        entitlement.credentialVersion !== payload.credentialVersion
      ) {
        return null;
      }
      const holder = await deps.repositories.users.getById(currentHolderUserId);
      if (!holder?.emailVerified || !isDeliverableRecipient(holder.email)) return null;
      if (deps.emailSender.name === 'logging' || !deps.emailSender.sendTransactionalEmail)
        return null;
      const eventRecord = await deps.repositories.events.getById(entitlement.eventId);
      if (!eventRecord) return null;
      explicitRecipient = holder.email;
      deliveryAggregateId = entitlement.id;
      if (isUpgradeIssuance) {
        kind = 'ticket_upgrade_confirmed';
        idempotencyKey = `ticket-upgrade-confirmed:${entitlement.id}:${payload.upgradeFromEntitlementId}`;
        subject = 'Your C1RCLE ticket upgrade is confirmed';
        heading = 'Ticket upgrade confirmed';
        details = `<p>Your ticket for <strong>${escapeHtml(eventRecord.title)}</strong> was upgraded successfully.</p><p>Your previous ticket is no longer valid and the upgraded ticket is now in your C1RCLE account.</p>`;
      } else if (event.type === 'ticket.issued') {
        kind = 'ticket_issued_to_holder';
        idempotencyKey = `ticket-issued-holder:${entitlement.id}:${currentHolderUserId}`;
        subject = 'A C1RCLE ticket is ready in your account';
        heading = 'Your ticket is ready';
        details = `<p>A ticket for <strong>${escapeHtml(eventRecord.title)}</strong> is available in your C1RCLE account.</p>`;
      } else {
        kind = 'ticket_transfer_accepted';
        idempotencyKey = `ticket-transfer-accepted:${payload.transferId}:${payload.credentialVersion}`;
        subject = 'A C1RCLE ticket was transferred to your account';
        heading = 'Ticket transfer complete';
        details = `<p>Your ticket for <strong>${escapeHtml(eventRecord.title)}</strong> is now in your C1RCLE account.</p>`;
      }
    }
  } else if (event.type === 'waitlist.offered') {
    const payload = event.payload as {
      entryId: EntityId;
      eventId: EntityId;
      tierId: EntityId;
      reservationId: EntityId;
      expiresAt: string;
    };
    const entry = await deps.repositories.waitlist.getById(payload.entryId);
    if (
      !entry ||
      entry.status !== 'offered' ||
      entry.eventId !== payload.eventId ||
      entry.tierId !== payload.tierId ||
      entry.offerReservationId !== payload.reservationId ||
      entry.offerExpiresAt !== payload.expiresAt ||
      Date.parse(payload.expiresAt) <= deps.config.clock.now().getTime()
    ) {
      return null;
    }
    const guest = await deps.repositories.users.getById(entry.userId);
    if (
      !guest?.emailVerified ||
      !isDeliverableRecipient(guest.email) ||
      deps.emailSender.name === 'logging' ||
      !deps.emailSender.sendTransactionalEmail
    ) {
      return null;
    }
    const eventRecord = await deps.repositories.events.getById(entry.eventId);
    if (!eventRecord) return null;
    explicitRecipient = guest.email;
    deliveryAggregateId = entry.id;
    kind = 'waitlist_offer';
    idempotencyKey = `waitlist-offer:${entry.id}:${payload.reservationId}`;
    subject = `A ticket offer is available for ${eventRecord.title}`;
    heading = 'Your waitlist offer is ready';
    details = `<p>A ticket offer for <strong>${escapeHtml(eventRecord.title)}</strong> is reserved for you.</p><p>Sign in to your C1RCLE Tickets area to review and accept it before <strong>${escapeHtml(new Date(payload.expiresAt).toISOString())}</strong>.</p><p>This offer will not charge you automatically.</p>`;
  } else if (event.type === 'waitlist.expired') {
    const payload = event.payload as EventPayloads['waitlist.expired'];
    const entry = await deps.repositories.waitlist.getById(payload.entryId);
    if (!entry || entry.eventId !== payload.eventId || entry.tierId !== payload.tierId) return null;
    const guest = await deps.repositories.users.getById(entry.userId);
    if (!guest?.emailVerified || !isDeliverableRecipient(guest.email)) return null;
    const eventRecord = await deps.repositories.events.getById(entry.eventId);
    if (!eventRecord) return null;
    explicitRecipient = guest.email;
    deliveryAggregateId = entry.id;
    kind = 'waitlist_offer_expired';
    idempotencyKey = `waitlist-offer-expired:${entry.id}:${payload.reservationId ?? 'none'}`;
    subject = `Your waitlist offer for ${eventRecord.title} expired`;
    heading = 'Waitlist offer expired';
    details = `<p>Your reserved waitlist offer for <strong>${escapeHtml(eventRecord.title)}</strong> expired before it was accepted.</p><p>No automatic payment was taken. You can rejoin the waitlist if tickets remain available.</p>`;
  } else if (
    event.type === 'promoter.assignment.invited' ||
    event.type === 'promoter.assignment.accepted' ||
    event.type === 'promoter.assignment.rejected' ||
    event.type === 'promoter.assignment.revoked' ||
    event.type === 'promoter.assignment.expired'
  ) {
    const payload = event.payload as
      | EventPayloads['promoter.assignment.invited']
      | EventPayloads['promoter.assignment.accepted']
      | EventPayloads['promoter.assignment.rejected']
      | EventPayloads['promoter.assignment.revoked']
      | EventPayloads['promoter.assignment.expired'];
    const recipientOrganizationId =
      event.type === 'promoter.assignment.invited' ||
      event.type === 'promoter.assignment.revoked' ||
      event.type === 'promoter.assignment.expired'
        ? payload.promoterId
        : 'eventOwnerId' in payload
          ? payload.eventOwnerId
          : payload.promoterId;
    const organization = await deps.repositories.organizations.getById(recipientOrganizationId);
    if (!organization) return null;
    explicitRecipient = await deps.userDirectory.getEmailById(organization.ownerId);
    if (!explicitRecipient || !isDeliverableRecipient(explicitRecipient)) return null;
    deliveryAggregateId = payload.assignmentId;
    kind =
      event.type === 'promoter.assignment.expired'
        ? 'promoter_assignment_expired'
        : 'promoter_assignment_status';
    const expiry = 'expiresAt' in payload ? payload.expiresAt : 'unknown';
    idempotencyKey =
      event.type === 'promoter.assignment.expired'
        ? `promoter-assignment-expired:${payload.assignmentId}:${expiry}`
        : `promoter-assignment-email:${payload.assignmentId}:${event.type}`;
    const eventTitle = payload.eventTitle ?? 'your event assignment';
    const copy =
      event.type === 'promoter.assignment.invited'
        ? {
            subject: 'You have a new C1RCLE Promoter assignment',
            heading: 'Promoter assignment invitation',
            details: `<p>You have been invited to promote <strong>${escapeHtml(eventTitle)}</strong>.</p><p>Sign in to review the campaign dates, eligible tiers and frozen commission terms.</p>`,
          }
        : event.type === 'promoter.assignment.accepted'
          ? {
              subject: 'A C1RCLE Promoter assignment was accepted',
              heading: 'Promoter assignment accepted',
              details: `<p>The Promoter accepted the assignment for <strong>${escapeHtml(eventTitle)}</strong>.</p>`,
            }
          : event.type === 'promoter.assignment.rejected'
            ? {
                subject: 'A C1RCLE Promoter assignment was declined',
                heading: 'Promoter assignment declined',
                details: `<p>The Promoter declined the assignment for <strong>${escapeHtml(eventTitle)}</strong>.</p>`,
              }
            : event.type === 'promoter.assignment.revoked'
              ? {
                  subject: 'A C1RCLE Promoter assignment was revoked',
                  heading: 'Promoter assignment revoked',
                  details: `<p>The assignment for <strong>${escapeHtml(eventTitle)}</strong> was revoked. Existing attribution records remain available for review.</p>`,
                }
              : {
                  subject: 'A C1RCLE Promoter assignment expired',
                  heading: 'Promoter assignment expired',
                  details: `<p>The assignment for <strong>${escapeHtml(eventTitle)}</strong> expired.</p>`,
                };
    subject = copy.subject;
    heading = copy.heading;
    details = copy.details;
  } else if (
    event.type === 'event-cover.redeemed' ||
    event.type === 'event-cover.reversed' ||
    event.type === 'event-cover.refunded'
  ) {
    const payload = event.payload as
      | EventPayloads['event-cover.redeemed']
      | EventPayloads['event-cover.reversed']
      | EventPayloads['event-cover.refunded'];
    const account = await deps.repositories.eventCoverAccounts.getByEntitlement(
      payload.entitlementId,
    );
    if (!account || account.id !== payload.accountId || !account.guestUserId) return null;
    const guest = await deps.repositories.users.getById(account.guestUserId);
    if (!guest?.emailVerified || !isDeliverableRecipient(guest.email)) return null;
    const eventRecord = await deps.repositories.events.getById(payload.eventId);
    if (!eventRecord) return null;
    explicitRecipient = guest.email;
    deliveryAggregateId = account.id;
    kind = 'event_cover_status';
    idempotencyKey = `event-cover-email:${event.type}:${account.id}:${payload.operationId}`;
    const copy =
      event.type === 'event-cover.redeemed'
        ? {
            subject: 'Your C1RCLE cover was redeemed',
            heading: 'Cover redeemed',
            details: `<p><strong>${money(payload.amountPaise)}</strong> of your event cover was redeemed at the venue for <strong>${escapeHtml(eventRecord.title)}</strong>.</p>`,
          }
        : event.type === 'event-cover.reversed'
          ? {
              subject: 'Your C1RCLE cover redemption was reversed',
              heading: 'Cover redemption reversed',
              details: `<p><strong>${money(payload.amountPaise)}</strong> was restored to your event cover balance for <strong>${escapeHtml(eventRecord.title)}</strong>.</p>`,
            }
          : {
              subject: 'Your C1RCLE cover refund was recorded',
              heading: 'Cover refund recorded',
              details: `<p><strong>${money(payload.amountPaise)}</strong> of event cover was refunded for <strong>${escapeHtml(eventRecord.title)}</strong>.</p>`,
            };
    subject = copy.subject;
    heading = copy.heading;
    details = copy.details;
  } else if (event.type === 'ticket.addon.redeemed') {
    const payload = event.payload as EventPayloads['ticket.addon.redeemed'];
    const entitlement = await deps.repositories.entitlements.getById(payload.entitlementId);
    if (!entitlement || entitlement.eventId !== payload.eventId || entitlement.status === 'void') {
      return null;
    }
    const holderId = currentEntitlementHolderId(entitlement);
    if (!holderId) return null;
    const holder = await deps.repositories.users.getById(holderId);
    if (!holder?.emailVerified || !isDeliverableRecipient(holder.email)) return null;
    const eventRecord = await deps.repositories.events.getById(payload.eventId);
    const addon = await deps.repositories.catalog.getTicketAddonById(payload.addonId);
    if (!eventRecord || !addon) return null;
    explicitRecipient = holder.email;
    deliveryAggregateId = entitlement.id;
    kind = 'ticket_addon_redeemed';
    idempotencyKey = `ticket-addon-redeemed:${payload.addonEntitlementId}`;
    subject = 'Your C1RCLE add-on was redeemed';
    heading = 'Add-on redeemed';
    details = `<p>Your <strong>${escapeHtml(addon.name)}</strong> add-on was redeemed for <strong>${escapeHtml(eventRecord.title)}</strong>.</p>`;
  } else if (event.type === 'finance.refund.settled') {
    const payload = event.payload as {
      orderId: EntityId;
      refundRequestId: EntityId;
      amountPaise: number;
    };
    order = await deps.repositories.orders.getById(payload.orderId);
    const refund = await deps.repositories.refundRequests.getById(payload.refundRequestId);
    if (!order || !refund || refund.status !== 'settled') return null;
    deliveryAggregateId = order.id;
    if (!isDeliverableRecipient(order.contact.email)) return null;
    kind = 'refund_completed';
    idempotencyKey = `refund-completed:${refund.id}`;
    subject = 'Your C1RCLE refund is complete';
    heading = 'Refund processed';
    const entitlements = await deps.repositories.entitlements.getByOrderId(order.id);
    const refundedCount = refund.targetEntitlementIds.length;
    const remaining = entitlements.filter(
      (ticket) => ticket.status === 'valid' && !ticket.refundLock,
    ).length;
    details = `<p>Refunded amount: <strong>${money(refund.amountPaise)}</strong></p><p>Affected tickets: ${refundedCount}</p><p>Remaining valid tickets: ${remaining}</p><p>Your bank or payment provider may take additional time to reflect the credit.</p><p>Support reference: ${escapeHtml(order.bookingReference ?? order.id)}</p>`;
  } else if (event.type === 'event.cancellation.order_affected') {
    const payload = event.payload as { eventId: EntityId; orderId: EntityId; reason: string };
    order = await deps.repositories.orders.getById(payload.orderId);
    const eventRecord = await deps.repositories.events.getById(payload.eventId);
    if (!order || !eventRecord || (order.status !== 'refund_requested' && order.status !== 'paid'))
      return null;
    deliveryAggregateId = order.id;
    if (!isDeliverableRecipient(order.contact.email)) return null;
    kind = 'event_cancelled';
    idempotencyKey = `event-change:${eventRecord.id}:${eventRecord.version}:${order.id}`;
    subject = `Update: ${eventRecord.title} has been cancelled`;
    heading = 'Event cancelled';
    details = `<p><strong>${escapeHtml(eventRecord.title)}</strong> has been cancelled.</p><p>${escapeHtml(payload.reason)}</p><p>If a refund applies, it remains subject to the existing review process. We will notify you when it is completed.</p><p>Booking reference: ${escapeHtml(order.bookingReference ?? order.id)}</p>`;
  } else if (event.type === 'event.material_change.order_affected') {
    const payload = event.payload as {
      eventId: EntityId;
      orderId: EntityId;
      entitlementId?: EntityId | null;
      eventVersion: number;
      previousTitle: string;
      title: string;
      previousStartAt: string;
      startAt: string;
      previousVenueId?: EntityId | null;
      venueId?: EntityId | null;
    };
    order = await deps.repositories.orders.getById(payload.orderId);
    if (!order || !['paid', 'refund_requested'].includes(order.status)) return null;
    deliveryAggregateId = order.id;
    if (payload.entitlementId) {
      const entitlement = await deps.repositories.entitlements.getById(payload.entitlementId);
      if (
        !entitlement ||
        entitlement.orderId !== order.id ||
        entitlement.eventId !== payload.eventId ||
        entitlement.status === 'void'
      ) {
        return null;
      }
      const holderUserId = currentEntitlementHolderId(entitlement);
      if (holderUserId) {
        const holder = await deps.repositories.users.getById(holderUserId);
        if (!holder?.emailVerified || !isDeliverableRecipient(holder.email)) return null;
        explicitRecipient = holder.email;
      } else if (isDeliverableRecipient(order.contact.email)) {
        explicitRecipient = order.contact.email;
      } else {
        return null;
      }
    } else if (isDeliverableRecipient(order.contact.email)) {
      // Backward compatibility for already queued order-level change events.
      explicitRecipient = order.contact.email;
    } else {
      return null;
    }
    const eventRecord = await deps.repositories.events.getById(payload.eventId);
    if (!eventRecord) return null;
    const [previousVenue, currentVenue] = await Promise.all([
      payload.previousVenueId
        ? deps.repositories.venues.getById(payload.previousVenueId)
        : Promise.resolve(null),
      eventRecord.venueId
        ? deps.repositories.venues.getById(eventRecord.venueId)
        : Promise.resolve(null),
    ]);
    kind = 'event_material_change';
    const recipientHash = createHash('sha256')
      .update(explicitRecipient.trim().toLowerCase())
      .digest('hex');
    idempotencyKey = `event-change:${eventRecord.id}:${payload.eventVersion}:${order.id}:${recipientHash}`;
    subject = `Important update: ${payload.title}`;
    heading = 'Event details have changed';
    const oldDate = new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'Asia/Kolkata',
    }).format(new Date(payload.previousStartAt));
    const newDate = new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'Asia/Kolkata',
    }).format(new Date(payload.startAt));
    const venueChange =
      payload.previousVenueId !== undefined && payload.previousVenueId !== eventRecord.venueId
        ? `<p>Venue: ${escapeHtml(previousVenue?.public.name ?? 'Previous venue unavailable')} → ${escapeHtml(currentVenue?.public.name ?? 'Venue details unavailable')}</p>`
        : '';
    details = `<p>Event: <strong>${escapeHtml(payload.previousTitle)}</strong> is now <strong>${escapeHtml(payload.title)}</strong>.</p><p>Previous date and time: ${escapeHtml(oldDate)} (Asia/Kolkata)</p><p>New date and time: ${escapeHtml(newDate)} (Asia/Kolkata)</p>${venueChange}<p>Booking reference: ${escapeHtml(order.bookingReference ?? order.id)}</p>`;
  } else if (event.type === 'event.material_change.refund_requested') {
    const payload = event.payload as EventPayloads['event.material_change.refund_requested'];
    order = await deps.repositories.orders.getById(payload.orderId);
    const entitlement = await deps.repositories.entitlements.getById(payload.entitlementId);
    if (
      !order ||
      !entitlement ||
      order.userId === null ||
      order.userId === undefined ||
      entitlement.orderId !== order.id ||
      entitlement.eventId !== payload.eventId ||
      order.eventId !== payload.eventId ||
      !['paid', 'refund_requested'].includes(order.status)
    ) {
      return null;
    }
    const purchaser = await deps.repositories.users.getById(order.userId);
    if (!purchaser?.emailVerified || !isDeliverableRecipient(purchaser.email)) return null;
    const eventRecord = await deps.repositories.events.getById(payload.eventId);
    if (!eventRecord) return null;
    explicitRecipient = purchaser.email;
    deliveryAggregateId = entitlement.id;
    kind = 'refund_review_requested';
    idempotencyKey = `refund-review-requested:${entitlement.id}:${payload.eventVersion}`;
    subject = `Your refund review request for ${eventRecord.title} was recorded`;
    heading = 'Refund review requested';
    details = `<p>We recorded your request to review a refund for <strong>${escapeHtml(eventRecord.title)}</strong>.</p><p>No refund has been approved or issued automatically. The request is now available for operator review.</p><p>Booking reference: ${escapeHtml(order.bookingReference ?? order.id)}</p>`;
  } else if (event.type === 'payment.support_required') {
    const payload = event.payload as { paymentId: string; holdId: EntityId; stateVersion: number };
    const hold = await deps.repositories.cartReservations.getById(payload.holdId);
    if (!hold) return null;
    explicitRecipient = hold.attendee?.email ?? null;
    if (!explicitRecipient && hold.userId) {
      explicitRecipient = await deps.userDirectory.getEmailById(hold.userId);
    }
    if (!explicitRecipient || !isDeliverableRecipient(explicitRecipient)) return null;
    kind = 'payment_support_required';
    idempotencyKey = `payment-support:${payload.paymentId}:${payload.stateVersion}`;
    subject = 'Action needed to complete your C1RCLE payment';
    heading = 'We need your help with this payment';
    details = `<p>We could not safely confirm the payment automatically. Please contact support and quote payment reference <strong>${escapeHtml(payload.paymentId)}</strong>.</p><p>Do not retry payment until support confirms its status.</p>`;
  } else if (event.type === 'finance.payout.status_changed') {
    const payload = event.payload as {
      payoutId: EntityId;
      organizationId: EntityId;
      status: 'requested' | 'processing' | 'paid' | 'failed' | 'frozen';
      version: number;
      amountPaise: number;
    };
    if (payload.status === 'frozen') return null;
    const organization = await deps.repositories.organizations.getById(payload.organizationId);
    if (!organization) return null;
    explicitRecipient = await deps.userDirectory.getEmailById(organization.ownerId);
    if (!explicitRecipient || !isDeliverableRecipient(explicitRecipient)) return null;
    const names = {
      requested: 'requested',
      processing: 'being processed',
      paid: 'completed',
      failed: 'not completed',
    } as const;
    kind = 'payout_status';
    idempotencyKey = `payout:${payload.payoutId}:${payload.version}`;
    subject = `C1RCLE payout ${names[payload.status]}`;
    heading = `Payout ${names[payload.status]}`;
    details = `<p>Amount: <strong>${money(payload.amountPaise)}</strong></p><p>Reference: ${escapeHtml(payload.payoutId)}</p><p>Current status: ${escapeHtml(payload.status)}.</p>`;
  } else if (
    event.type === 'promoter.onboarding.submitted' ||
    event.type === 'promoter.onboarding.approved' ||
    event.type === 'promoter.onboarding.rejected'
  ) {
    const payload = event.payload as
      | EventPayloads['promoter.onboarding.submitted']
      | EventPayloads['promoter.onboarding.approved']
      | EventPayloads['promoter.onboarding.rejected'];
    const application = await deps.repositories.onboarding.getById(payload.requestId);
    if (!application) return null;
    const expectedStatus =
      event.type === 'promoter.onboarding.submitted'
        ? 'submitted'
        : event.type === 'promoter.onboarding.approved'
          ? 'approved'
          : 'rejected';
    if (application.status !== expectedStatus) return null;
    explicitRecipient = await deps.userDirectory.getEmailById(application.userId);
    if (!explicitRecipient || !isDeliverableRecipient(explicitRecipient)) return null;
    kind = 'promoter_onboarding_status';
    idempotencyKey = `promoter-onboarding:${application.id}:${expectedStatus}`;
    deliveryAggregateId = application.id;
    subject =
      expectedStatus === 'submitted'
        ? 'Your C1RCLE partner application was submitted'
        : expectedStatus === 'approved'
          ? 'Your C1RCLE partner application was approved'
          : 'Update on your C1RCLE partner application';
    heading =
      expectedStatus === 'submitted'
        ? 'Application submitted'
        : expectedStatus === 'approved'
          ? 'Application approved'
          : 'Application not approved';
    details =
      expectedStatus === 'submitted'
        ? `<p>We received the partner application for <strong>${escapeHtml(application.profile.legalName)}</strong>. The team will review it and update you here.</p>`
        : expectedStatus === 'approved'
          ? `<p>The partner application for <strong>${escapeHtml(application.profile.legalName)}</strong> was approved. Sign in to continue in the partner workspace.</p>`
          : `<p>The partner application for <strong>${escapeHtml(application.profile.legalName)}</strong> was not approved. Sign in to review the application status.</p>`;
  } else if (event.type === 'promoter.assignments.status_changed') {
    const payload = event.payload as EventPayloads['promoter.assignments.status_changed'];
    if (payload.status !== 'suspended') return null;
    const organization = await deps.repositories.organizations.getById(payload.promoterId);
    if (
      !organization ||
      !organization.members.some((member) => member.capabilities.includes('promoter'))
    )
      return null;
    explicitRecipient = await deps.userDirectory.getEmailById(organization.ownerId);
    if (!explicitRecipient || !isDeliverableRecipient(explicitRecipient)) return null;
    kind = 'promoter_suspended';
    idempotencyKey = `promoter-suspended:${payload.promoterId}:${event.id}`;
    subject = 'Your C1RCLE Promoter assignments were suspended';
    heading = 'Promoter assignments suspended';
    details = `<p>${payload.affectedAssignments} event assignment${payload.affectedAssignments === 1 ? ' was' : 's were'} paused by an administrator. Sign in to the partner workspace for current details.</p>`;
  } else {
    return null;
  }

  if (!order && !explicitRecipient) return null;
  const to = explicitRecipient?.trim() ?? order?.contact.email.trim() ?? '';
  if (!isDeliverableRecipient(to)) return null;
  const eventRecord = order ? await deps.repositories.events.getById(order.eventId) : null;
  const venue =
    order && eventRecord?.venueId
      ? await deps.repositories.venues.getById(eventRecord.venueId)
      : null;
  const actionUrl = 'https://thec1rcle.com/tickets';
  const supportUrl = 'https://thec1rcle.com/help';
  const termsUrl = 'https://thec1rcle.com/terms';
  const footer = order
    ? `<p>Event: <strong>${escapeHtml(eventRecord?.title ?? order.eventCancellation?.eventTitle ?? 'Event details unavailable')}</strong></p>${eventRecord ? `<p>Venue: ${escapeHtml(venue?.public.name ?? 'Venue details unavailable')}</p>${Number.isFinite(Date.parse(eventRecord.startAt)) ? `<p>Date and time: ${escapeHtml(new Intl.DateTimeFormat('en-IN', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(eventRecord.startAt)))} (Asia/Kolkata)</p>` : ''}` : ''}<p>Order reference: ${escapeHtml(order.id)}</p>${event.type === 'order.fulfilled' ? receiptAmounts(order) : ''}<p><a href="${actionUrl}" style="color:#ff5a00">View your tickets</a></p><p>Need help? <a href="${supportUrl}" style="color:#ff5a00">Contact support</a> and quote ${escapeHtml(order.bookingReference ?? order.id)}.</p><p><a href="${termsUrl}" style="color:#999">Terms</a></p>`
    : event.type === 'ticket.transfer.created' || event.type === 'ticket.transfer.invitation_resent'
      ? `<p>This invitation is bound to the verified account it was sent to. The ticket will not move until that account accepts it.</p><p><a href="${supportUrl}" style="color:#ff5a00">Contact support</a> if you were not expecting this invitation.</p>`
      : event.type === 'payment.support_required'
        ? `<p><a href="${supportUrl}" style="color:#ff5a00">Contact support</a> for help with this payment.</p>`
        : event.type === 'ticket.issued' || event.type === 'ticket.transfer.resolved'
          ? `<p><a href="${actionUrl}" style="color:#ff5a00">View your ticket</a></p><p>We sent this notice to the verified email on the current ticket holder's account.</p>`
          : event.type.startsWith('promoter.onboarding.')
            ? '<p>Review your application in the C1RCLE partner workspace.</p>'
            : event.type === 'promoter.assignments.status_changed' ||
                event.type === 'promoter.assignment.expired'
              ? '<p>Review your assignments in the C1RCLE partner workspace.</p>'
              : '<p>Review the Finance section in your partner workspace for details.</p>';
  const html = `<div style="background:#080808;color:#f7f7f7;padding:32px;font-family:Arial,sans-serif;max-width:620px;margin:auto"><div style="color:#ff5a00;font-weight:800;letter-spacing:3px">THE C1RCLE</div><h1>${escapeHtml(heading)}</h1>${details}<hr style="border-color:#333">${footer}</div>`;
  return { to, subject, html, idempotencyKey, kind, aggregateId: deliveryAggregateId };
}

async function enqueueMaterialChangeRecipients(
  event: DomainEvent,
  deps: ServiceDeps,
): Promise<void> {
  let payload: {
    eventId: EntityId;
    eventVersion: number;
    previousTitle: string;
    title: string;
    previousStartAt: string;
    startAt: string;
    previousVenueId?: EntityId | null;
    venueId?: EntityId | null;
    cursor: string | null;
  };
  if (event.type === 'event.updated') {
    const change = (event.payload as { materialChange?: MaterialChange | null }).materialChange;
    if (!change) return;
    payload = { eventId: event.aggregateId, ...change, cursor: null };
  } else {
    payload = event.payload as typeof payload;
  }
  const page = await deps.repositories.orders.listByEvent(payload.eventId, {
    cursor: payload.cursor,
    limit: 50,
  });
  for (const order of page.items) {
    if (!['paid', 'refund_requested'].includes(order.status)) continue;
    const entitlements = (await deps.repositories.entitlements.getByOrderId(order.id)).filter(
      (entitlement) => entitlement.status !== 'void',
    );
    const noticeEntitlements = new Map<string, EntityId | null>();
    for (const entitlement of entitlements) {
      const holderId = currentEntitlementHolderId(entitlement);
      const recipientGroup = holderId ?? `unassigned:${order.id}`;
      if (!noticeEntitlements.has(recipientGroup))
        noticeEntitlements.set(recipientGroup, entitlement.id);
    }
    // The purchaser remains the financial owner even after ticket transfer,
    // so preserve their order-level notice alongside current-holder notices.
    // Recipient-hash idempotency in buildMessage deduplicates this when both
    // roles intentionally use the same address.
    noticeEntitlements.set(`order-contact:${order.id}`, null);

    for (const entitlementId of noticeEntitlements.values()) {
      await deps.outbox.append(
        domainEvent({
          id: deterministicDomainEventId(
            'event.material_change.order_affected',
            payload.eventId,
            String(payload.eventVersion),
            order.id,
            entitlementId ?? 'order-contact',
          ),
          type: 'event.material_change.order_affected',
          aggregateId: order.id,
          organizationId: order.organizationId,
          actorId: event.actorId,
          payload: {
            eventId: payload.eventId,
            orderId: order.id,
            entitlementId,
            eventVersion: payload.eventVersion,
            previousTitle: payload.previousTitle,
            title: payload.title,
            previousStartAt: payload.previousStartAt,
            startAt: payload.startAt,
            previousVenueId: payload.previousVenueId ?? null,
            venueId: payload.venueId ?? null,
          },
          occurredAt: deps.config.clock.now().getTime(),
        }),
      );
    }
  }
  if (page.nextCursor !== null) {
    await deps.outbox.append(
      domainEvent({
        id: deterministicDomainEventId(
          'event.material_change.batch_requested',
          payload.eventId,
          String(payload.eventVersion),
          page.nextCursor,
        ),
        type: 'event.material_change.batch_requested',
        aggregateId: payload.eventId,
        organizationId: event.organizationId,
        actorId: event.actorId,
        payload: { ...payload, cursor: page.nextCursor },
        occurredAt: deps.config.clock.now().getTime(),
      }),
    );
  }
}

async function receiptDetails(order: Order, deps: ServiceDeps): Promise<string> {
  const event = await deps.repositories.events.getById(order.eventId);
  return `<p>Booking reference: <strong>${escapeHtml(order.bookingReference ?? order.id)}</strong></p><p>Event: ${escapeHtml(event?.title ?? 'Event details unavailable')}</p><ul>${order.lines.map((line) => `<li>${escapeHtml(line.tierName)} × ${line.quantity}</li>`).join('')}</ul>`;
}

function receiptAmounts(order: Order): string {
  return `<p>Subtotal: ${money(order.subtotalPaise)}</p><p>Discount: −${money(order.discountPaise)}</p><p>Fees: ${money(order.platformFeePaise + order.paymentFeePaise)}</p><p>Taxes: ${money(order.gstPaise)}</p><p>Total paid: <strong>${money(order.grandTotalPaise)}</strong></p>${order.refundedPaise > 0 ? `<p>Refunds recorded: ${money(order.refundedPaise)}</p>` : ''}<p>Payment reference: ${escapeHtml(order.paymentId ?? '')}</p>`;
}

function money(paise: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
}

function isDeliverableRecipient(value: string): boolean {
  return (
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) &&
    !value.endsWith('@example.com') &&
    !value.endsWith('@example.test')
  );
}
