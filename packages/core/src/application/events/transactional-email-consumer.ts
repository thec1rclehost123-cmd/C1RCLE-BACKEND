import { createHash } from 'node:crypto';

import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
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
      eventVersion: number;
      previousTitle: string;
      title: string;
      previousStartAt: string;
      startAt: string;
    };
    order = await deps.repositories.orders.getById(payload.orderId);
    if (!order || !['paid', 'refund_requested'].includes(order.status)) return null;
    deliveryAggregateId = order.id;
    if (!isDeliverableRecipient(order.contact.email)) return null;
    const eventRecord = await deps.repositories.events.getById(payload.eventId);
    if (!eventRecord) return null;
    kind = 'event_material_change';
    idempotencyKey = `event-change:${eventRecord.id}:${payload.eventVersion}:${order.id}`;
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
    details = `<p>Event: <strong>${escapeHtml(payload.previousTitle)}</strong> is now <strong>${escapeHtml(payload.title)}</strong>.</p><p>Previous date and time: ${escapeHtml(oldDate)} (Asia/Kolkata)</p><p>New date and time: ${escapeHtml(newDate)} (Asia/Kolkata)</p><p>Booking reference: ${escapeHtml(order.bookingReference ?? order.id)}</p>`;
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
    ? `<p>Event: <strong>${escapeHtml(eventRecord?.title ?? order.eventCancellation?.eventTitle ?? 'Event details unavailable')}</strong></p>${eventRecord ? `<p>Venue: ${escapeHtml(venue?.public.name ?? 'Venue details unavailable')}</p><p>Date and time: ${escapeHtml(new Intl.DateTimeFormat('en-IN', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(eventRecord.startAt)))} (Asia/Kolkata)</p>` : ''}<p>Order reference: ${escapeHtml(order.id)}</p>${event.type === 'order.fulfilled' ? receiptAmounts(order) : ''}<p><a href="${actionUrl}" style="color:#ff5a00">View your tickets</a></p><p>Need help? <a href="${supportUrl}" style="color:#ff5a00">Contact support</a> and quote ${escapeHtml(order.bookingReference ?? order.id)}.</p><p><a href="${termsUrl}" style="color:#999">Terms</a></p>`
    : event.type === 'payment.support_required'
      ? `<p><a href="${supportUrl}" style="color:#ff5a00">Contact support</a> for help with this payment.</p>`
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
    await deps.outbox.append(
      domainEvent({
        id: deterministicDomainEventId(
          'event.material_change.order_affected',
          payload.eventId,
          String(payload.eventVersion),
          order.id,
        ),
        type: 'event.material_change.order_affected',
        aggregateId: order.id,
        organizationId: order.organizationId,
        actorId: event.actorId,
        payload: {
          eventId: payload.eventId,
          orderId: order.id,
          eventVersion: payload.eventVersion,
          previousTitle: payload.previousTitle,
          title: payload.title,
          previousStartAt: payload.previousStartAt,
          startAt: payload.startAt,
        },
        occurredAt: deps.config.clock.now().getTime(),
      }),
    );
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
