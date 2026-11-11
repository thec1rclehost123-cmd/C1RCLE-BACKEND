import { createHash } from 'node:crypto';

import { guestPortalOrigin } from '../../config/index.js';
import { ConflictError } from '../../domain/errors.js';
import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import { currentEntitlementHolderId } from '../../domain/models/entitlement.js';
import { PermanentEmailDeliveryError } from '../../domain/ports/email-sender.js';
import {
  renderC1rcleBrandHeader,
  renderC1rcleEditorialEyebrow,
  renderC1rcleEmailShell,
  renderC1rclePrimaryCta,
} from '../email/c1rcle-email-chrome.js';
import { htmlToPlainText } from '../email/html-to-plain-text.js';

import type { DomainEvent, EventPayloads } from '../../domain/events.js';
import type { EntityId } from '../../domain/identity.js';
import type { Event } from '../../domain/models/event.js';
import type { Order } from '../../domain/models/order.js';
import type { Venue } from '../../domain/models/venue.js';
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
    await deliverMessage(message, deps);
    if (
      event.type === 'ticket.transfer.resolved' &&
      (event.payload as EventPayloads['ticket.transfer.resolved']).status === 'accepted'
    ) {
      const formerHolderMessage = await buildFormerHolderTransferMessage(event, deps);
      if (formerHolderMessage) await deliverMessage(formerHolderMessage, deps);
    }
  };
}

async function deliverMessage(
  message: NonNullable<Awaited<ReturnType<typeof buildMessage>>>,
  deps: ServiceDeps,
): Promise<void> {
  const id = `MAIL-${createHash('sha256').update(message.idempotencyKey).digest('hex').slice(0, 40)}`;
  const recipientHash = createHash('sha256').update(message.to.trim().toLowerCase()).digest('hex');
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
  const attemptCount = (await deps.emailDeliveries.get(id))?.retryCount ?? 1;
  try {
    if (!deps.emailSender.sendTransactionalEmail)
      throw new Error('Transactional email sender unavailable');
    const result = await deps.emailSender.sendTransactionalEmail({
      ...message,
      deliveryIntentId: id,
    });
    if (result.outcome === 'captured_locally') {
      await deps.emailDeliveries.markCaptured(id, deps.config.clock.now().getTime());
      deps.logger?.info('transactional_email_delivery', {
        intentId: id,
        templateType: message.kind,
        outcome: 'captured_locally',
        attemptCount,
      });
    } else if (result.providerMessageId) {
      await deps.emailDeliveries.markSent(
        id,
        result.providerMessageId,
        deps.config.clock.now().getTime(),
      );
      deps.logger?.info('transactional_email_delivery', {
        intentId: id,
        templateType: message.kind,
        outcome: 'accepted_by_provider',
        providerMessageId: result.providerMessageId,
        attemptCount,
      });
    } else {
      throw new Error('Email sender did not report a delivery outcome');
    }
  } catch (error) {
    // Provider errors can contain request/recipient data. Keep only a safe
    // category in durable evidence and let the outbox apply its retry policy.
    if (error instanceof PermanentEmailDeliveryError) {
      await deps.emailDeliveries.markPermanentFailure(
        id,
        'Transactional email permanently rejected',
        deps.config.clock.now().getTime(),
      );
      deps.logger?.warn('transactional_email_delivery', {
        intentId: id,
        templateType: message.kind,
        outcome: 'permanent_failure',
        attemptCount,
      });
      return;
    }
    await deps.emailDeliveries.markFailed(
      id,
      'Transactional email provider failure',
      deps.config.clock.now().getTime(),
    );
    deps.logger?.warn('transactional_email_delivery', {
      intentId: id,
      templateType: message.kind,
      outcome: 'retryable_failure',
      attemptCount,
    });
    throw new Error('Transactional email delivery failed');
  }
}

async function buildFormerHolderTransferMessage(event: DomainEvent, deps: ServiceDeps) {
  const payload = event.payload as EventPayloads['ticket.transfer.resolved'];
  if (!payload.transferId) return null;
  const transfer = await deps.repositories.entitlements.getTicketTransfer(payload.transferId);
  if (!transfer || transfer.status !== 'accepted' || transfer.eventId !== payload.eventId)
    return null;
  const formerHolder = await deps.repositories.users.getById(transfer.senderUserId);
  if (!formerHolder?.emailVerified || !isDeliverableRecipient(formerHolder.email)) return null;
  const eventRecord = await deps.repositories.events.getById(transfer.eventId);
  if (!eventRecord) return null;
  const portal = guestPortalOrigin(deps.config.guestPortalUrl);
  const walletUrl = new URL('/tickets', portal).toString();
  const html = renderEmailLayout(
    'Ticket transfer complete',
    `<p>Your ticket for <strong>${escapeHtml(eventRecord.title)}</strong> was transferred to its new holder.</p><p><a href="${escapeHtml(walletUrl)}" style="color:#ff5a00">View your tickets</a></p>`,
    'The ticket is now held by its new owner.',
    {
      event: eventRecord,
      venue: eventRecord.venueId
        ? await deps.repositories.venues.getById(eventRecord.venueId)
        : null,
      kind: 'ticket_transfer_former_holder',
      guestOrigin: portal,
      actionUrl: walletUrl,
      supportUrl: new URL('/help', portal).toString(),
      termsUrl: new URL('/terms', portal).toString(),
    },
  );
  return {
    to: formerHolder.email,
    subject: 'Your C1RCLE ticket transfer is complete',
    html,
    preheader: 'The ticket is now held by its new owner.',
    text: `Ticket transfer complete\n\nYour ticket for ${eventRecord.title} was transferred to its new holder.\n\nView your tickets: ${walletUrl}`,
    templateType: 'ticket_transfer_former_holder',
    idempotencyKey: `ticket-transfer-former-holder:${transfer.id}:${payload.credentialVersion}`,
    kind: 'ticket_transfer_former_holder',
    aggregateId: transfer.id,
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
  let presentationEvent: Event | null = null;

  if (event.type === 'order.fulfilled') {
    const { orderId } = event.payload as { orderId: EntityId };
    order = await deps.repositories.orders.getById(orderId);
    if (!order || order.status !== 'paid' || order.fulfillmentState === 'pending') return null;
    if (!isDeliverableRecipient(order.contact.email)) return null;
    const isRsvp = order.grandTotalPaise === 0;
    kind = isRsvp ? 'rsvp_confirmation' : 'booking_receipt';
    idempotencyKey = `${isRsvp ? 'rsvp-confirmation' : 'booking-receipt'}:${order.id}:fulfilled`;
    subject = isRsvp ? "You're on the list" : "You're in";
    heading = isRsvp ? "You're on the list." : "You're in.";
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
      Date.parse(transfer.expiresAt) <= deps.config.clock.now().getTime()
    ) {
      return null;
    }
    if (transfer.recipientEmail && !transfer.recipientEmailHash) return null;
    const recipient = transfer.recipientUserId
      ? await deps.repositories.users.getById(transfer.recipientUserId)
      : null;
    const deliveryEmail =
      transfer.recipientEmail?.trim().toLowerCase() ??
      (recipient?.emailVerified ? recipient.email.trim().toLowerCase() : null);
    if (
      !deliveryEmail ||
      !isDeliverableRecipient(deliveryEmail) ||
      (transfer.recipientEmailHash &&
        createHash('sha256').update(deliveryEmail).digest('hex') !== transfer.recipientEmailHash)
    )
      return null;
    const entitlement = await deps.repositories.entitlements.getById(transfer.entitlementId);
    const eventRecord = entitlement
      ? await deps.repositories.events.getById(entitlement.eventId)
      : null;
    presentationEvent = eventRecord;
    if (
      !entitlement ||
      !eventRecord ||
      entitlement.status !== 'valid' ||
      entitlement.pendingTransferId !== transfer.id ||
      (currentEntitlementHolderId(entitlement) !== transfer.senderUserId &&
        !(entitlement.currentHolderUserId === null && entitlement.userId === transfer.senderUserId))
    ) {
      return null;
    }
    if (deps.emailSender.name === 'logging' || !deps.emailSender.sendTransactionalEmail)
      return null;
    explicitRecipient = deliveryEmail;
    deliveryAggregateId = transfer.id;
    kind = 'ticket_transfer_invitation';
    idempotencyKey = payload.deliveryRequestId
      ? `ticket-transfer-invitation:${transfer.id}:${payload.deliveryRequestId}`
      : `ticket-transfer-invitation:${transfer.id}`;
    subject = 'A ticket is waiting for you';
    heading = 'A ticket is waiting for you.';
    const transferUrl = new URL(
      `/ticket-transfer/${encodeURIComponent(transfer.id)}`,
      guestPortalOrigin(deps.config.guestPortalUrl),
    ).toString();
    details = `<p>A ticket for <strong>${escapeHtml(eventRecord.title)}</strong> is waiting for you. Create a C1RCLE account if needed and verify this email address before accepting.</p><p><a href="${transferUrl}" style="color:#ff5a00">Review this invitation</a></p><p>Sign in with the verified email address this invitation was sent to. Your ticket holder will change only after you accept.</p>`;
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
      presentationEvent = eventRecord;
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
      if (entitlement.fulfillmentRequired) {
        const paidOrder = await deps.repositories.orders.getById(entitlement.orderId);
        if (!paidOrder || paidOrder.fulfillmentState !== 'complete')
          throw new ConflictError('Ticket delivery is waiting for payment completion');
      }
      const currentHolderUserId = currentEntitlementHolderId(entitlement);
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
      presentationEvent = eventRecord;
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
  } else if (
    event.type === 'venue.slot_request.created' ||
    event.type === 'venue.slot_request.accepted' ||
    event.type === 'venue.slot_request.rejected' ||
    event.type === 'venue.slot_request.cancelled'
  ) {
    const request = await deps.repositories.slotRequests.getById(event.aggregateId);
    if (!request) return null;
    const venue = await deps.repositories.venues.getById(request.venueId);
    const host = await deps.repositories.organizations.getById(request.hostId);
    if (!venue || !host) return null;
    const recipientOrganization =
      event.type === 'venue.slot_request.created'
        ? venue.organizationId
        : event.type === 'venue.slot_request.cancelled' && event.organizationId === request.hostId
          ? venue.organizationId
          : request.hostId;
    const organization = recipientOrganization === venue.organizationId ? null : host;
    const ownerId =
      recipientOrganization === venue.organizationId ? venue.ownerId : organization?.ownerId;
    if (!ownerId) return null;
    explicitRecipient = await deps.userDirectory.getEmailById(ownerId);
    if (!explicitRecipient || !isDeliverableRecipient(explicitRecipient)) return null;
    deliveryAggregateId = request.id;
    kind = `venue_slot_request_${event.type.slice('venue.slot_request.'.length)}`;
    idempotencyKey = `venue-slot-request:${request.id}:${event.type}`;
    const linkedEvent = request.eventId
      ? await deps.repositories.events.getById(request.eventId)
      : null;
    const proposedTitle = request.eventDraft?.event.title;
    const eventName =
      linkedEvent?.title ?? (typeof proposedTitle === 'string' ? proposedTitle : 'a Host event');
    const accepted = event.type === 'venue.slot_request.accepted';
    const rejected = event.type === 'venue.slot_request.rejected';
    const cancelled = event.type === 'venue.slot_request.cancelled';
    subject = accepted
      ? 'Your C1RCLE Venue slot request was accepted'
      : rejected
        ? 'Update on your C1RCLE Venue slot request'
        : cancelled
          ? 'A C1RCLE Venue slot request was cancelled'
          : 'A Host requested a Venue slot';
    heading = accepted
      ? 'Slot request accepted'
      : rejected
        ? 'Slot request declined'
        : cancelled
          ? 'Slot request cancelled'
          : 'New slot request';
    details = accepted
      ? request.eventDraft
        ? `<p>Your request for <strong>${escapeHtml(eventName)}</strong> was accepted and the event is now published on the Guest Portal.</p>`
        : `<p>Your request for <strong>${escapeHtml(eventName)}</strong> was accepted. The Host can now continue preparing the event.</p>`
      : rejected
        ? `<p>The Venue declined the slot request for <strong>${escapeHtml(eventName)}</strong>.</p>`
        : cancelled
          ? `<p>The slot request for <strong>${escapeHtml(eventName)}</strong> was cancelled.</p>`
          : `<p>A Host requested a Venue slot for <strong>${escapeHtml(eventName)}</strong>. Sign in to review the request and its proposed time.</p>`;
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
    presentationEvent = eventRecord;
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
    presentationEvent = eventRecord;
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
    explicitRecipient = await refundRecipient(order, deps);
    if (!explicitRecipient) return null;
    kind = 'refund_completed';
    idempotencyKey = `refund-completed:${refund.id}`;
    subject = `Your ${money(refund.amountPaise)} refund is complete`;
    heading = 'Refund complete.';
    const entitlements = await deps.repositories.entitlements.getByOrderId(order.id);
    const refundedCount = refund.targetEntitlementIds.length;
    const remaining = entitlements.filter(
      (ticket) => ticket.status === 'valid' && !ticket.refundLock,
    ).length;
    details = `<p>Refunded amount: <strong>${money(refund.amountPaise)}</strong></p><p>Affected tickets: ${refundedCount}</p><p>Remaining valid tickets: ${remaining}</p><p>Your bank or payment provider may take additional time to reflect the credit.</p>${bookingReferenceParagraph(order, 'Support reference')}`;
  } else if (event.type === 'finance.refund.finalized') {
    const payload = event.payload as EventPayloads['finance.refund.finalized'];
    order = await deps.repositories.orders.getById(payload.orderId);
    const refund = await deps.repositories.refundRequests.getById(payload.refundRequestId);
    if (!order || !refund || refund.status !== 'rejected' || refund.status !== payload.status)
      return null;
    explicitRecipient = await refundRecipient(order, deps);
    if (!explicitRecipient) return null;
    deliveryAggregateId = order.id;
    kind = 'refund_not_completed';
    idempotencyKey = `refund-not-completed:${refund.id}:${refund.status}`;
    subject = 'Update on your C1RCLE refund';
    heading = 'Refund request declined';
    details = `<p>Your refund request was declined after review. No refund was issued.</p>${bookingReferenceParagraph(order, 'Booking reference')}<p>Contact support if you have questions.</p>`;
  } else if (event.type === 'event.cancellation.email_requested') {
    const payload = event.payload as EventPayloads['event.cancellation.email_requested'];
    order = await deps.repositories.orders.getById(payload.orderId);
    const eventRecord = await deps.repositories.events.getById(payload.eventId);
    presentationEvent = eventRecord;
    if (!order || !eventRecord || !['refund_requested', 'paid', 'cancelled'].includes(order.status))
      return null;
    deliveryAggregateId = order.id;
    if (payload.entitlementId) {
      const entitlement = await deps.repositories.entitlements.getById(payload.entitlementId);
      if (
        !entitlement ||
        entitlement.orderId !== order.id ||
        entitlement.eventId !== payload.eventId
      )
        return null;
      const holderId = currentEntitlementHolderId(entitlement);
      const holder = holderId ? await deps.repositories.users.getById(holderId) : null;
      if (holder?.emailVerified && isDeliverableRecipient(holder.email))
        explicitRecipient = holder.email;
    } else if (isDeliverableRecipient(order.contact.email)) {
      explicitRecipient = order.contact.email;
    }
    if (!explicitRecipient) return null;
    kind = 'event_cancelled';
    idempotencyKey = `event-cancelled:${eventRecord.id}:${payload.eventVersion}:${order.id}:${createHash('sha256').update(explicitRecipient.trim().toLowerCase()).digest('hex')}`;
    subject = `${eventRecord.title} has been cancelled`;
    heading = 'Event cancelled';
    details = `<p><strong>${escapeHtml(eventRecord.title)}</strong> has been cancelled.</p><p>${escapeHtml(payload.reason)}</p><p>If a refund applies, it remains subject to the existing review process. We will notify you when it is completed.</p>${bookingReferenceParagraph(order)}`;
  } else if (event.type === 'event.material_change.order_affected') {
    const payload = event.payload as {
      eventId: EntityId;
      orderId: EntityId;
      entitlementId?: EntityId | null;
      eventVersion: number;
      changeType?: 'postponed' | 'rescheduled';
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
    presentationEvent = eventRecord;
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
    heading =
      payload.changeType === 'postponed'
        ? 'Event postponed — new date to be announced'
        : payload.changeType === 'rescheduled'
          ? 'A new event date has been announced'
          : 'Event details have changed';
    const oldDate = new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'Asia/Kolkata',
    }).format(new Date(payload.previousStartAt));
    const newDate =
      payload.changeType === 'postponed'
        ? 'To be announced'
        : new Intl.DateTimeFormat('en-IN', {
            dateStyle: 'long',
            timeStyle: 'short',
            timeZone: 'Asia/Kolkata',
          }).format(new Date(payload.startAt));
    const venueChange =
      payload.previousVenueId !== undefined && payload.previousVenueId !== eventRecord.venueId
        ? `<p>Venue: ${escapeHtml(previousVenue?.public.name ?? 'Previous venue unavailable')} → ${escapeHtml(currentVenue?.public.name ?? 'Venue details unavailable')}</p>`
        : '';
    details = `<p>Event: <strong>${escapeHtml(payload.previousTitle)}</strong> is now <strong>${escapeHtml(payload.title)}</strong>.</p><p>Previous date and time: ${escapeHtml(oldDate)} (Asia/Kolkata)</p><p>New date and time: ${escapeHtml(newDate)} (Asia/Kolkata)</p>${venueChange}${bookingReferenceParagraph(order)}`;
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
    presentationEvent = eventRecord;
    if (!eventRecord) return null;
    explicitRecipient = purchaser.email;
    deliveryAggregateId = entitlement.id;
    kind = 'refund_review_requested';
    idempotencyKey = `refund-review-requested:${entitlement.id}:${payload.eventVersion}`;
    subject = `Your refund review request for ${eventRecord.title} was recorded`;
    heading = 'Refund review requested';
    details = `<p>We recorded your request to review a refund for <strong>${escapeHtml(eventRecord.title)}</strong>.</p><p>No refund has been approved or issued automatically. The request is now available for operator review.</p>${bookingReferenceParagraph(order)}`;
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
    details =
      '<p>We could not safely confirm the payment automatically. Please contact support before retrying.</p><p>Do not retry payment until support confirms its status.</p>';
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
    details = `<p>Amount: <strong>${money(payload.amountPaise)}</strong></p><p>Current status: ${escapeHtml(payload.status)}.</p>`;
  } else if (event.type === 'partner.onboarding.email_requested') {
    const payload = event.payload as EventPayloads['partner.onboarding.email_requested'];
    const application = await deps.repositories.onboarding.getById(payload.requestId);
    if (!application) return null;
    const requestedType = application.requestedType ?? 'promoter';
    const expectedStatus = payload.status;
    if (application.status !== expectedStatus) return null;
    explicitRecipient = await deps.userDirectory.getEmailById(application.userId);
    if (!explicitRecipient || !isDeliverableRecipient(explicitRecipient)) return null;
    kind = `partner_onboarding_${expectedStatus}`;
    idempotencyKey = `promoter-onboarding:${application.id}:${expectedStatus}`;
    deliveryAggregateId = application.id;
    subject =
      expectedStatus === 'submitted'
        ? 'Application received'
        : expectedStatus === 'changes_requested'
          ? `Your ${requestedType.charAt(0).toUpperCase()}${requestedType.slice(1)} application needs an update`
          : expectedStatus === 'approved'
            ? `Your ${requestedType.charAt(0).toUpperCase()}${requestedType.slice(1)} application is approved`
            : 'Update on your application';
    heading =
      expectedStatus === 'submitted'
        ? 'Application submitted'
        : expectedStatus === 'changes_requested'
          ? 'Your application needs an update'
          : expectedStatus === 'approved'
            ? 'Application approved'
            : 'Application not approved';
    const dashboard = deps.config.partnerDashboardUrl;
    const applicationUrl = dashboard ? new URL('/onboard', dashboard).toString() : null;
    const studioUrl = dashboard
      ? new URL(`/partner/${requestedType}/overview`, dashboard).toString()
      : null;
    details =
      expectedStatus === 'submitted'
        ? `<p>We received your ${escapeHtml(requestedType)} application. The team will review it and update you here.</p>${applicationUrl ? `<p><a href="${escapeHtml(applicationUrl)}">View your application</a></p>` : '<p>Sign in to C1RCLE to view your application.</p>'}`
        : expectedStatus === 'changes_requested'
          ? `<p>Your ${escapeHtml(requestedType)} application needs attention before review can continue.</p>${application.reviewNote ? `<p>${escapeHtml(application.reviewNote)}</p>` : ''}${applicationUrl ? `<p><a href="${escapeHtml(applicationUrl)}">Continue your application</a></p>` : '<p>Sign in to C1RCLE to continue your application.</p>'}`
          : expectedStatus === 'approved'
            ? `<p>Your ${escapeHtml(requestedType)} application is approved.</p>${studioUrl ? `<p><a href="${escapeHtml(studioUrl)}">Open ${escapeHtml(requestedType)} Studio</a></p>` : '<p>Sign in to C1RCLE to open your partner workspace.</p>'}`
            : `<p>Your ${escapeHtml(requestedType)} application was not approved.</p>${application.reviewNote ? `<p>${escapeHtml(application.reviewNote)}</p>` : ''}${applicationUrl ? `<p><a href="${escapeHtml(applicationUrl)}">Review application status</a></p>` : '<p>Sign in to C1RCLE to review your application status.</p>'}`;
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
  const eventRecord = order
    ? await deps.repositories.events.getById(order.eventId)
    : presentationEvent;
  const venue = eventRecord?.venueId
    ? await deps.repositories.venues.getById(eventRecord.venueId)
    : null;
  const guestOrigin = guestPortalOrigin(deps.config.guestPortalUrl);
  const actionUrl = new URL('/tickets', guestOrigin).toString();
  const supportUrl = new URL('/help', guestOrigin).toString();
  const termsUrl = new URL('/terms', guestOrigin).toString();
  const partnerDashboardUrl = deps.config.partnerDashboardUrl;
  const promoterOverviewUrl = partnerDashboardUrl
    ? new URL('/partner/promoter/overview', partnerDashboardUrl).toString()
    : null;
  const partnerWorkspaceUrl = partnerDashboardUrl
    ? new URL('/partner/select-organization', partnerDashboardUrl).toString()
    : null;
  const footer = order
    ? `<p>Event: <strong>${escapeHtml(eventRecord?.title ?? order.eventCancellation?.eventTitle ?? 'Event details unavailable')}</strong></p>${eventRecord ? `<p>Venue: ${escapeHtml(venue?.public.name ?? 'Venue details unavailable')}</p>${Number.isFinite(Date.parse(eventRecord.startAt)) ? `<p>Date and time: ${escapeHtml(new Intl.DateTimeFormat('en-IN', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(eventRecord.startAt)))} (Asia/Kolkata)</p>` : ''}` : ''}<p><a href="${actionUrl}" style="color:#ff5a00">View your tickets</a></p><p>Need help? <a href="${supportUrl}" style="color:#ff5a00">Contact support</a>${order.bookingReference ? ` and quote ${escapeHtml(order.bookingReference)}` : ''}.</p><p><a href="${termsUrl}" style="color:#999">Terms</a></p>`
    : event.type === 'ticket.transfer.created' || event.type === 'ticket.transfer.invitation_resent'
      ? `<p>This invitation is bound to the verified account it was sent to. The ticket will not move until that account accepts it.</p><p><a href="${supportUrl}" style="color:#ff5a00">Contact support</a> if you were not expecting this invitation.</p>`
      : event.type === 'payment.support_required'
        ? `<p><a href="${supportUrl}" style="color:#ff5a00">Contact support</a> for help with this payment.</p>`
        : event.type === 'ticket.issued' || event.type === 'ticket.transfer.resolved'
          ? `<p><a href="${actionUrl}" style="color:#ff5a00">View your ticket</a></p><p>We sent this notice to the verified email on the current ticket holder's account.</p>`
          : event.type === 'event-cover.redeemed' ||
              event.type === 'event-cover.reversed' ||
              event.type === 'event-cover.refunded' ||
              event.type === 'ticket.addon.redeemed'
            ? `<p><a href="${actionUrl}" style="color:#ff5a00">View your tickets</a></p><p><a href="${supportUrl}" style="color:#ff5a00">Contact support</a></p>`
            : event.type.startsWith('promoter.assignment.') ||
                event.type === 'promoter.assignments.status_changed'
              ? promoterOverviewUrl
                ? `<p><a href="${promoterOverviewUrl}" style="color:#ff5a00">View assignments</a></p>`
                : '<p>Sign in to the partner workspace to review your assignments.</p>'
              : event.type === 'finance.payout.status_changed'
                ? partnerWorkspaceUrl
                  ? `<p><a href="${partnerWorkspaceUrl}" style="color:#ff5a00">Open partner workspace</a></p>`
                  : '<p>Sign in to the partner workspace to review Finance.</p>'
                : event.type === 'partner.onboarding.email_requested'
                  ? '<p>Review your application in the C1RCLE partner workspace.</p>'
                  : event.type === 'promoter.assignment.expired'
                    ? '<p>Review your assignments in the C1RCLE partner workspace.</p>'
                    : '<p>Review the Finance section in your partner workspace for details.</p>';
  const experienceHeading = getExperienceHeading(kind, heading);
  const preheader = createPreheader(kind, experienceHeading, eventRecord?.title);
  const html =
    kind === 'booking_receipt' && order
      ? renderPurchaseReceiptEmail({
          order,
          event: eventRecord,
          venue,
          guestOrigin,
          actionUrl,
          supportUrl,
          termsUrl,
          preheader,
        })
      : renderEmailLayout(
          heading,
          `${details}<hr style="border:0;border-top:1px solid #333;margin:24px 0">${footer}`,
          preheader,
          {
            event: eventRecord,
            venue,
            kind,
            guestOrigin,
            actionUrl,
            supportUrl,
            termsUrl,
          },
        );
  const text =
    kind === 'booking_receipt' && order
      ? purchaseReceiptText({
          order,
          event: eventRecord,
          venue,
          guestOrigin,
          actionUrl,
          supportUrl,
          termsUrl,
        })
      : `${experienceHeading}\n\n${htmlToPlainText(details)}\n\n${htmlToPlainText(footer)}`;
  return {
    to,
    subject,
    preheader,
    html,
    text,
    templateType: kind,
    idempotencyKey,
    kind,
    aggregateId: deliveryAggregateId,
  };
}

function createPreheader(kind: string, heading: string, eventTitle?: string): string {
  if (eventTitle && kind === 'booking_receipt') return `Your tickets for ${eventTitle} are ready.`;
  if (eventTitle && getEmailLayoutFamily(kind) === 'event')
    return `Event details and your next step for ${eventTitle}.`;
  if (kind.includes('refund')) return 'A final update on your refund request.';
  if (kind.includes('onboarding')) return 'Review the latest status of your application.';
  if (kind.includes('transfer')) return 'An update about a ticket transfer.';
  if (kind.includes('payout')) return 'The latest status of your C1RCLE payout.';
  if (kind.includes('payment')) return 'Review the next step for your payment.';
  if (kind.includes('promoter')) return 'Review the latest update to your assignment.';
  if (kind === 'event_cancelled') return 'What this change means for your ticket.';
  if (kind.includes('material_change')) return 'See the updated event date or venue.';
  return `A status update from C1RCLE: ${heading}.`;
}

function getExperienceHeading(kind: string, fallback: string): string {
  const headings: Record<string, string> = {
    rsvp_confirmation: "You're on the list.",
    ticket_transfer_invitation: 'A ticket is waiting for you.',
    ticket_transfer_accepted: "It's yours.",
    ticket_transfer_former_holder: 'Ticket transferred.',
    ticket_issued_to_holder: "Your ticket's ready.",
    ticket_upgrade_confirmed: 'Upgrade confirmed.',
    event_cancelled: "This one's cancelled.",
    event_material_change: 'Plans changed.',
    refund_completed: 'Refund complete.',
    refund_not_completed: 'Refund update.',
    partner_onboarding_submitted: 'Application received.',
    partner_onboarding_changes_requested: 'One more thing.',
    partner_onboarding_approved: "You're approved.",
    partner_onboarding_rejected: 'Application update.',
  };
  return headings[kind] ?? fallback;
}

interface EmailLayoutView {
  event: Event | null;
  venue: Venue | null;
  kind: string;
  guestOrigin: string;
  actionUrl: string;
  supportUrl: string;
  termsUrl: string;
}

/** Shared email-safe shell for event, partner and financial messages. */
function renderEmailLayout(
  heading: string,
  content: string,
  preheader: string,
  view?: EmailLayoutView,
): string {
  const experienceHeading = getExperienceHeading(view?.kind ?? '', heading);
  const [details = content, footer = ''] = content.split(/<hr\b[^>]*>/i, 2);
  const compactFooter = footer.replace(/<p\b[^>]*>[\s\S]*?<\/p>/gi, (paragraph) => {
    const label = htmlToPlainText(paragraph).trim().toLowerCase();
    return /^(event|venue|date and time|order reference|subtotal|discount|fees|taxes|total paid|payment reference):/.test(
      label,
    )
      ? ''
      : paragraph;
  });
  const detailAction = extractEmailAction(details);
  const footerAction = detailAction.action ? null : extractEmailAction(compactFooter);
  const primaryAction = detailAction.action ?? footerAction?.action ?? null;
  const body = styleEmailBody(
    styleSecondaryEmailLinks(
      [detailAction.html, footerAction?.html ?? compactFooter].filter(Boolean).join(''),
    ),
  );
  const eventTitle = view?.event?.title ?? null;
  const family = getEmailLayoutFamily(view?.kind ?? '');
  const eventHeader =
    view?.event && family === 'event'
      ? renderEventHeader(view.event, view.venue)
      : eventTitle
        ? `<tr><td style="padding:0 24px 18px;color:#c8c8c8;font-size:16px;line-height:1.45;font-weight:700;overflow-wrap:anywhere;">${escapeHtml(eventTitle)}</td></tr>`
        : '';
  const primaryCta = primaryAction ? renderPrimaryCta(primaryAction.url, primaryAction.label) : '';

  const eyebrow =
    getEmailLayoutFamily(view?.kind ?? '') === 'event'
      ? 'YOUR C1RCLE UPDATE'
      : getEmailLayoutFamily(view?.kind ?? '') === 'partner'
        ? 'PARTNER ACCOUNT'
        : getEmailLayoutFamily(view?.kind ?? '') === 'financial'
          ? 'PAYMENT UPDATE'
          : 'ACCOUNT UPDATE';
  return renderEmailShell(
    preheader,
    `${renderBrandHeader()}${renderEditorialEyebrow(eyebrow)}<tr><td style="padding:10px 24px 22px;"><h1 style="margin:0;color:#ffffff;font-size:40px;line-height:1.02;font-weight:800;letter-spacing:-1.25px;overflow-wrap:anywhere;">${escapeHtml(experienceHeading)}</h1></td></tr>${eventHeader}<tr><td style="padding:0 24px 28px;color:#dedede;font-size:16px;line-height:1.65;overflow-wrap:anywhere;word-break:break-word;">${body}</td></tr>${primaryCta}<tr><td style="padding:20px 24px 32px;color:#929292;font-size:13px;line-height:1.7;overflow-wrap:anywhere;border-top:1px solid #292929;">${renderQuietFooter(view)}</td></tr>`,
  );
}

function renderEmailShell(preheader: string, rows: string): string {
  return renderC1rcleEmailShell(preheader, rows);
}

function renderBrandHeader(): string {
  return renderC1rcleBrandHeader();
}

function renderEditorialEyebrow(label: string): string {
  return renderC1rcleEditorialEyebrow(label);
}

function renderPrimaryCta(url: string, label: string): string {
  return renderC1rclePrimaryCta(url, label);
}

function styleEmailBody(html: string): string {
  return html
    .replace(/<p\b[^>]*>\s*<\/p>/gi, '')
    .replace(
      /<p\b[^>]*>/gi,
      '<p style="margin:0 0 14px;color:#dedede;font-size:16px;line-height:1.65;overflow-wrap:anywhere;word-break:break-word;">',
    )
    .replace(/<strong\b([^>]*)>/gi, (_tag, attributes: string) => {
      const cleanAttributes = attributes.replace(/\sstyle=["'][^"']*["']/i, '');
      return `<strong${cleanAttributes} style="color:#ffffff;font-weight:700;">`;
    });
}

function renderQuietFooter(view?: EmailLayoutView): string {
  if (!view)
    return '<strong style="color:#d5d5d5;letter-spacing:1.8px;font-size:11px;">THE C1RCLE</strong>';
  const help = `<a href="${escapeHtml(view.supportUrl)}" style="color:#aaaaaa;text-decoration:underline;">Contact support</a>`;
  const terms = `<a href="${escapeHtml(view.termsUrl)}" style="color:#777777;text-decoration:underline;">Terms</a>`;
  return `<strong style="display:block;margin-bottom:10px;color:#d5d5d5;letter-spacing:1.8px;font-size:11px;">THE C1RCLE</strong>Need help? ${help}<br /><span style="display:inline-block;padding-top:8px;">${terms}</span>`;
}

function getEmailLayoutFamily(kind: string): 'event' | 'partner' | 'financial' | 'operational' {
  if (
    [
      'booking_receipt',
      'rsvp_confirmation',
      'ticket_transfer_invitation',
      'ticket_transfer_former_holder',
      'ticket_transfer_expired',
      'ticket_transfer_accepted',
      'ticket_issued_to_holder',
      'ticket_upgrade_confirmed',
      'event_cancelled',
      'event_material_change',
    ].includes(kind)
  ) {
    return 'event';
  }
  if (kind.includes('onboarding') || kind.includes('promoter')) return 'partner';
  if (
    kind.includes('refund') ||
    kind.includes('payout') ||
    kind.includes('cover') ||
    kind.includes('payment')
  ) {
    return 'financial';
  }
  return 'operational';
}

function renderEventHeader(event: Event, venue: Venue | null): string {
  const poster = renderEventPoster(event, 472, 22);
  const date = formatPurchaseEventDate(event.startAt);
  const venueLine = formatPurchaseVenue(venue);
  const facts = [
    date ? `<span style="color:#f2f2f2;font-weight:700;">${escapeHtml(date)}</span>` : '',
    venueLine ? `<span style="color:#a9a9a9;">${escapeHtml(venueLine)}</span>` : '',
  ].filter(Boolean);
  return `<tr><td style="padding:0 24px 16px;color:#ffffff;font-size:28px;line-height:1.08;font-weight:800;letter-spacing:-0.65px;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(event.title)}</td></tr>${poster}${facts.length ? `<tr><td style="padding:0 24px 26px;font-size:14px;line-height:1.7;">${facts.join('<br />')}</td></tr>` : ''}`;
}

function renderEventPoster(event: Event, maxWidth: number, bottomPadding = 0): string {
  const posterUrl = getPurchasePosterUrl(event.imageUrl);
  if (!posterUrl) return '';
  return `<tr><td style="padding:0 24px ${bottomPadding}px;"><img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(event.title)} event poster" width="${maxWidth}" style="display:block;width:100%;max-width:${maxWidth}px;height:auto;border:0;color:#f7f7f7;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.4;" /></td></tr>`;
}

function extractEmailAction(html: string): {
  html: string;
  action: { url: string; label: string } | null;
} {
  const match = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(html);
  if (!match || !match[1] || !match[2]) return { html, action: null };
  const label = htmlToPlainText(match[2]).trim();
  if (!label) return { html, action: null };
  return {
    html: html.replace(match[0], ''),
    action: { url: match[1], label },
  };
}

function styleSecondaryEmailLinks(html: string): string {
  return html.replace(/<a\b([^>]*)>/gi, (_anchor, attributes: string) => {
    const cleanAttributes = attributes.replace(/\sstyle=["'][^"']*["']/i, '');
    return `<a${cleanAttributes} style="color:#bdbdbd;text-decoration:underline;">`;
  });
}

interface PurchaseReceiptViewModel {
  order: Order;
  event: Event | null;
  venue: Venue | null;
  guestOrigin: string;
  actionUrl: string;
  supportUrl: string;
  termsUrl: string;
  preheader?: string;
}

function renderPurchaseReceiptEmail(view: PurchaseReceiptViewModel): string {
  const { order, event, venue, guestOrigin, actionUrl, supportUrl, termsUrl, preheader } = view;
  const title = event?.title ?? 'Event details unavailable';
  const dateLine = event ? formatPurchaseEventDate(event.startAt) : null;
  const venueLine = formatPurchaseVenue(venue);
  const eventUrl = event ? getPurchaseEventUrl(event, guestOrigin) : null;
  const directionsUrl = getPurchaseDirectionsUrl(venue);
  const poster = event ? renderEventPoster(event, 472, 24) : '';
  const total = compactMoney(order.grandTotalPaise);
  const bookingReference = order.bookingReference?.trim() ?? '';
  const ticketRows = order.lines
    .map(
      (line) =>
        `<tr><td style="padding:15px 0;border-bottom:1px solid #292929;color:#ffffff;font-size:16px;line-height:1.4;font-weight:700;overflow-wrap:anywhere;">${escapeHtml(line.tierName)}</td><td align="right" style="padding:15px 0;border-bottom:1px solid #292929;color:#ff7540;font-size:13px;line-height:1.4;font-weight:800;white-space:nowrap;">${line.quantity} ${line.quantity === 1 ? 'TICKET' : 'TICKETS'}</td></tr>`,
    )
    .join('');
  const summary = purchaseReceiptSummaryRows(order)
    .map(
      ([label, value]) =>
        `<tr><td style="padding:9px 0;color:#a4a4a4;font-size:14px;line-height:1.45;">${escapeHtml(label)}</td><td align="right" style="padding:9px 0;color:#f0f0f0;font-size:14px;line-height:1.45;white-space:nowrap;">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  const eventActions = [
    eventUrl
      ? `<a href="${escapeHtml(eventUrl)}" style="color:#bdbdbd;text-decoration:underline;">View event</a>`
      : '',
    directionsUrl
      ? `<a href="${escapeHtml(directionsUrl)}" style="color:#bdbdbd;text-decoration:underline;">Directions</a>`
      : '',
  ].filter(Boolean);

  const rows = `${renderBrandHeader()}${renderEditorialEyebrow('PURCHASE CONFIRMED')}<tr><td style="padding:10px 24px 10px;"><h1 style="margin:0;color:#ffffff;font-size:48px;line-height:0.98;font-weight:800;letter-spacing:-1.7px;">You're in.</h1></td></tr><tr><td style="padding:0 24px 20px;color:#f7f7f7;font-size:30px;line-height:1.06;font-weight:800;letter-spacing:-0.8px;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(title)}</td></tr>${poster}<tr><td style="padding:0 24px 27px;">${dateLine ? `<p style="margin:0 0 8px;color:#ffffff;font-size:15px;line-height:1.4;font-weight:800;letter-spacing:0.65px;">${escapeHtml(dateLine)}</p>` : ''}${venueLine ? `<p style="margin:0;color:#a6a6a6;font-size:15px;line-height:1.5;overflow-wrap:anywhere;">${escapeHtml(venueLine)}</p>` : ''}</td></tr><tr><td style="padding:0 24px 5px;color:#8d8d8d;font-size:10px;line-height:1.3;font-weight:800;letter-spacing:1.8px;">YOUR TICKETS</td></tr><tr><td style="padding:0 24px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;"><tbody>${ticketRows || `<tr><td style="padding:15px 0;border-bottom:1px solid #292929;color:#dedede;font-size:15px;line-height:1.45;">Your tickets are in your C1RCLE Wallet.</td></tr>`}</tbody></table></td></tr><tr><td style="padding:0 24px 26px;"><p style="margin:0 0 5px;color:#929292;font-size:10px;line-height:1.3;font-weight:800;letter-spacing:1.8px;">TOTAL PAID</p><p style="margin:0;color:#ffffff;font-size:40px;line-height:1.02;font-weight:800;letter-spacing:-1.1px;">${escapeHtml(total)}</p></td></tr>${renderPrimaryCta(actionUrl, 'View tickets')}${eventActions.length ? `<tr><td style="padding:0 24px 32px;color:#a7a7a7;font-size:14px;line-height:1.6;">${eventActions.join('<span style="padding:0 12px;color:#ff5a00;">/</span>')}</td></tr>` : ''}<tr><td style="padding:21px 24px 8px;border-top:1px solid #292929;color:#ffffff;font-size:15px;line-height:1.3;font-weight:800;letter-spacing:0.35px;">ORDER SUMMARY</td></tr><tr><td style="padding:0 24px 25px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;"><tbody>${summary}<tr><td style="padding:13px 0 0;border-top:1px solid #333333;color:#f7f7f7;font-size:14px;line-height:1.4;font-weight:700;">Total</td><td align="right" style="padding:13px 0 0;border-top:1px solid #333333;color:#f7f7f7;font-size:14px;line-height:1.4;font-weight:700;white-space:nowrap;">${escapeHtml(total)}</td></tr></tbody></table></td></tr><tr><td style="padding:0 24px 20px;color:#8f8f8f;font-size:13px;line-height:1.65;">${bookingReference ? `Booking reference: <strong style="color:#c6c6c6;">${escapeHtml(bookingReference)}</strong><br />` : ''}Need help? <a href="${escapeHtml(supportUrl)}" style="color:#c6c6c6;text-decoration:underline;">Contact support</a>${bookingReference ? ' and quote your booking reference' : ''}.</td></tr><tr><td style="padding:20px 24px 32px;border-top:1px solid #292929;color:#777777;font-size:12px;line-height:1.6;"><strong style="display:block;margin-bottom:9px;color:#b6b6b6;letter-spacing:2px;font-size:10px;">THE C1RCLE</strong><a href="${escapeHtml(termsUrl)}" style="color:#929292;text-decoration:underline;">Terms</a></td></tr>`;
  return renderEmailShell(preheader ?? '', rows);
}

function purchaseReceiptText(view: PurchaseReceiptViewModel): string {
  const { order, event, venue, guestOrigin, actionUrl, supportUrl, termsUrl } = view;
  const lines = [
    "You're in.",
    event?.title ?? 'Event details unavailable',
    event ? (formatPurchaseEventDate(event.startAt) ?? '') : '',
    formatPurchaseVenue(venue) ?? '',
    ...order.lines.map((line) => `${line.quantity} × ${line.tierName}`),
    `Total paid: ${compactMoney(order.grandTotalPaise)}`,
    '',
    `View your tickets (${actionUrl})`,
  ];
  const eventUrl = event ? getPurchaseEventUrl(event, guestOrigin) : null;
  if (eventUrl) {
    lines.push(`View event (${eventUrl})`);
  }
  const directionsUrl = getPurchaseDirectionsUrl(venue);
  if (directionsUrl) lines.push(`Directions: ${directionsUrl}`);
  lines.push(
    '',
    'Order summary',
    ...purchaseReceiptSummaryRows(order).map(([label, value]) => `${label}: ${value}`),
    `Total: ${compactMoney(order.grandTotalPaise)}`,
  );
  if (order.bookingReference) lines.push('', `Booking reference: ${order.bookingReference}`);
  lines.push(`Need help? Contact support: ${supportUrl}`);
  if (order.bookingReference) lines.push('Quote your booking reference when contacting support.');
  lines.push(`Terms: ${termsUrl}`, 'THE C1RCLE');
  return lines.join('\n');
}

function purchaseReceiptSummaryRows(order: Order): [string, string][] {
  const rows: [string, string][] = [];
  const hasComponents = order.admissionSubtotalPaise !== undefined;
  if (hasComponents) {
    if ((order.admissionSubtotalPaise ?? 0) > 0)
      rows.push(['Tickets', compactMoney(order.admissionSubtotalPaise ?? 0)]);
    if ((order.addOnSubtotalPaise ?? 0) > 0)
      rows.push(['Add-ons', compactMoney(order.addOnSubtotalPaise ?? 0)]);
    if ((order.coverSubtotalPaise ?? 0) > 0)
      rows.push(['Event cover', compactMoney(order.coverSubtotalPaise ?? 0)]);
  } else {
    if (Number.isFinite(order.subtotalPaise))
      rows.push(['Subtotal', compactMoney(order.subtotalPaise)]);
  }
  if (order.discountPaise > 0) rows.push(['Discount', `−${compactMoney(order.discountPaise)}`]);
  if (order.platformFeePaise > 0) rows.push(['Platform fee', compactMoney(order.platformFeePaise)]);
  if (order.paymentFeePaise > 0)
    rows.push(['Payment processing fee', compactMoney(order.paymentFeePaise)]);
  if (order.gstPaise > 0) rows.push(['Taxes', compactMoney(order.gstPaise)]);
  return rows;
}

function formatPurchaseEventDate(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('weekday')} · ${part('month')} ${part('day')} · ${part('hour')}:${part('minute')} ${part('dayPeriod')} IST`.toUpperCase();
}

function formatPurchaseVenue(venue: Venue | null): string | null {
  if (!venue) return null;
  const address = venue.public.address;
  const locality = [address?.street, address?.city].filter(Boolean).join(', ');
  return [venue.public.name, locality].filter(Boolean).join(' · ');
}

function getPurchaseEventUrl(event: Event, guestOrigin: string): string | null {
  const idOrSlug = event.slug || event.id;
  if (!idOrSlug) return null;
  return new URL(`/event/${encodeURIComponent(idOrSlug)}`, guestOrigin).toString();
}

function getPurchaseDirectionsUrl(venue: Venue | null): string | null {
  if (!venue) return null;
  const { address } = venue.public;
  const hasCoordinates = Number.isFinite(address.lat) && Number.isFinite(address.lng);
  const destination = hasCoordinates
    ? `${address.lat},${address.lng}`
    : [venue.public.name, address.street, address.city, address.state, address.country]
        .filter(Boolean)
        .join(', ');
  if (!destination) return null;
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('destination', destination);
  return url.toString();
}

function getPurchasePosterUrl(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  try {
    const parsed = new URL(imageUrl);
    return parsed.protocol === 'https:' ? imageUrl : null;
  } catch {
    // Relative assets are allowed only to keep local synthetic preview fixtures
    // self-contained; persisted event artwork should use an absolute HTTPS URL.
    return /^\.\/[A-Za-z0-9._/-]+$/.test(imageUrl) && !imageUrl.includes('..') ? imageUrl : null;
  }
}

function compactMoney(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

async function refundRecipient(order: Order, deps: ServiceDeps): Promise<string | null> {
  if (order.userId) {
    const purchaser = await deps.repositories.users.getById(order.userId);
    return purchaser?.emailVerified && isDeliverableRecipient(purchaser.email)
      ? purchaser.email.trim().toLowerCase()
      : null;
  }
  return isDeliverableRecipient(order.contact.email)
    ? order.contact.email.trim().toLowerCase()
    : null;
}

async function enqueueMaterialChangeRecipients(
  event: DomainEvent,
  deps: ServiceDeps,
): Promise<void> {
  let payload: {
    eventId: EntityId;
    eventVersion: number;
    changeType?: 'postponed' | 'rescheduled';
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
    // Operational event-change notices follow the current holder. The
    // purchaser remains the financial owner and is notified separately for
    // refund outcomes; do not send event-change notices to a former holder
    // after assignment or transfer. Fall back to the purchaser only for an
    // order that has no surviving entitlement to identify a current holder.
    if (noticeEntitlements.size === 0) noticeEntitlements.set(`order-contact:${order.id}`, null);

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
            ...(payload.changeType ? { changeType: payload.changeType } : {}),
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
  const bookingReference = order.bookingReference
    ? `<p>Booking reference: <strong>${escapeHtml(order.bookingReference)}</strong></p>`
    : '';
  return `${bookingReference}<p>Event: ${escapeHtml(event?.title ?? 'Event details unavailable')}</p><ul>${order.lines.map((line) => `<li>${escapeHtml(line.tierName)} × ${line.quantity}</li>`).join('')}</ul>`;
}

function bookingReferenceParagraph(order: Order, label = 'Booking reference'): string {
  const bookingReference = order.bookingReference?.trim();
  return bookingReference ? `<p>${escapeHtml(label)}: ${escapeHtml(bookingReference)}</p>` : '';
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
