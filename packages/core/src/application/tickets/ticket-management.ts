import { createHash } from 'node:crypto';

import { NotFoundError, UnauthorizedError } from '../../domain/errors.js';
import { canAdmit, currentEntitlementHolderId } from '../../domain/models/entitlement.js';
import {
  eventQrUnavailableReason,
  eventTransferUnavailableReason,
} from '../../domain/models/event-policy.js';
import {
  refundReviewTicketId,
  refundReviewEligibility,
} from '../../domain/models/refund-review.js';

import type { Entitlement } from '../../domain/models/entitlement.js';
import type { Event } from '../../domain/models/event.js';
import type { PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

export function ticketTransfersAvailable(deps: ServiceDeps): boolean {
  return deps.config.features.m5OfflineTicketManifests !== true;
}

export function isFreeRsvp(ticket: Entitlement): boolean {
  return (
    ticket.unitKind === 'free_rsvp' ||
    (ticket.unitKind === undefined && ticket.orderId.startsWith('RSVP-'))
  );
}

function unavailableReason(
  deps: ServiceDeps,
  ticket: Entitlement,
  event: Event | null,
): string | null {
  if (isFreeRsvp(ticket)) return 'Free RSVPs cannot be transferred.';
  if (ticket.status !== 'valid' || ticket.scanCount > 0)
    return 'Only unused tickets can be transferred.';
  if (ticket.refundLock) return 'This ticket is locked while a refund is reviewed.';
  if (!event || event.status === 'cancelled') return 'This event is unavailable for transfers.';
  const reason = eventTransferUnavailableReason(event, deps.config.clock.now());
  if (reason) return reason;
  if (!ticketTransfersAvailable(deps)) return 'Ticket transfers are not available right now.';
  return null;
}

export async function managedTicketRow(
  deps: ServiceDeps,
  ticket: Entitlement,
  actor: ActorContext,
) {
  const holder = currentEntitlementHolderId(ticket);
  const ownership =
    holder === null
      ? ('unassigned' as const)
      : holder === actor.userId
        ? ('you' as const)
        : ('transferred' as const);
  const [event, order, transfer] = await Promise.all([
    deps.repositories.events.getById(ticket.eventId),
    deps.repositories.orders.getById(ticket.orderId),
    ticket.pendingTransferId
      ? deps.repositories.entitlements.getTicketTransfer(ticket.pendingTransferId)
      : Promise.resolve(null),
  ]);
  const review = await deps.repositories.supportTickets?.getById(
    refundReviewTicketId(actor.userId, ticket.id),
  );
  const refundEligibility =
    event && order
      ? refundReviewEligibility(event, order, ticket, actor.userId, deps.config.clock.now())
      : { allowed: false, reason: 'Event or order details are unavailable.' };
  const venue = event?.venueId ? await deps.repositories.venues?.getById(event.venueId) : null;
  const now = deps.config.clock.now().getTime();
  const pendingTransfer =
    transfer &&
    ['pending', 'frozen'].includes(transfer.status) &&
    (transfer.status === 'frozen' || Date.parse(transfer.expiresAt) > now)
      ? { id: transfer.id, status: transfer.status, expiresAt: transfer.expiresAt }
      : null;
  let reason = unavailableReason(deps, ticket, event);
  if (ownership === 'transferred') reason = 'Only the current holder can transfer this ticket.';
  if (pendingTransfer)
    reason =
      pendingTransfer.status === 'frozen'
        ? 'This transfer is on hold. Contact support.'
        : 'An invitation is already pending.';
  if (!reason) {
    const cover = await deps.repositories.eventCoverAccounts?.getByEntitlement(ticket.id);
    if (cover && (cover.status !== 'active' || cover.reservedPaise > 0))
      reason = 'Transfer is unavailable while event cover is reserved or frozen.';
  }
  let refundPending = Boolean(ticket.refundLock);
  if (!refundPending && order?.status === 'refund_requested') {
    const requests = (await deps.repositories.refundRequests?.listByOrder(order.id)) ?? [];
    const pending = requests.filter((request) =>
      ['pending', 'approved', 'executing'].includes(request.status),
    );
    // Exact selection also protects a request persisted before its ticket locks.
    // Preserve whole-order/legacy locks when selection cannot be established.
    refundPending =
      pending.length === 0 ||
      pending.some(
        (request) =>
          request.scope !== 'ticket_lines' ||
          !request.targetEntitlementIds?.length ||
          request.targetEntitlementIds.includes(ticket.id),
      );
  }
  const status = refundPending
    ? ('refund_pending' as const)
    : event?.status === 'cancelled' || order?.eventCancellation
      ? ('cancelled' as const)
      : ticket.status === 'void'
        ? (order?.refundedPaise ?? 0) > 0
          ? ('refunded' as const)
          : ('cancelled' as const)
        : ticket.status === 'redeemed'
          ? ('used' as const)
          : ('active' as const);
  if (!reason && status !== 'active') reason = 'This ticket cannot be transferred.';
  return {
    id: ticket.id,
    orderId: ticket.orderId,
    eventId: ticket.eventId,
    eventStatus: event?.status ?? null,
    tierId: ticket.tierId,
    tierName: ticket.tierName,
    holderName: ownership === 'unassigned' ? null : ticket.holderName || 'Guest',
    ownership,
    unitKind: ticket.unitKind ?? (isFreeRsvp(ticket) ? ('free_rsvp' as const) : ('paid' as const)),
    status,
    eventTitle: event?.title ?? order?.eventCancellation?.eventTitle ?? 'Event details unavailable',
    eventSlug: event?.slug ?? null,
    startsAt: event?.status === 'postponed' ? null : (event?.startAt ?? null),
    endsAt: event?.status === 'postponed' ? null : (event?.endAt ?? null),
    posterUrl: event?.imageUrl ?? null,
    bookingReference: order?.bookingReference ?? null,
    canRequestRefund: refundEligibility.allowed,
    refundUnavailableReason: refundEligibility.reason,
    refundReview: review?.refundReview
      ? { id: review.id, status: review.status, requestedAt: review.refundReview.requestedAt }
      : null,
    canPresent:
      ownership === 'you' &&
      status === 'active' &&
      canAdmit(ticket) &&
      event !== null &&
      eventQrUnavailableReason(event, deps.config.clock.now()) === null,
    qrUnavailableReason:
      ownership !== 'you'
        ? 'Accept an assignment before using this ticket.'
        : !event
          ? 'Event unavailable'
          : eventQrUnavailableReason(event, deps.config.clock.now()),
    venueId: event?.venueId ?? null,
    venueName: venue?.public.name ?? null,
    venueCity: venue?.public.address.city ?? null,
    canTransfer: reason === null,
    transferUnavailableReason: reason,
    pendingTransfer,
  };
}

export async function readTicketManagement(deps: ServiceDeps, id: string, actor: ActorContext) {
  if (!actor.userId) throw new UnauthorizedError('Sign in to view tickets');
  const ticket = await deps.repositories.entitlements.getById(id);
  if (
    !ticket ||
    (ticket.userId !== actor.userId && currentEntitlementHolderId(ticket) !== actor.userId)
  )
    throw new NotFoundError('Ticket', id);
  return managedTicketRow(deps, ticket, actor);
}

export async function listPurchasedTicketManagement(
  deps: ServiceDeps,
  actor: ActorContext,
  query: PaginationQuery,
) {
  if (!actor.userId) throw new UnauthorizedError('Sign in to view bookings');
  const page = await deps.repositories.entitlements.listByUser(actor.userId, query);
  const items = [];
  // Keep Firestore read fan-out bounded while including all units on the page.
  for (let index = 0; index < page.items.length; index += 6) {
    items.push(
      ...(await Promise.all(
        page.items.slice(index, index + 6).map((ticket) => managedTicketRow(deps, ticket, actor)),
      )),
    );
  }
  return { items, nextCursor: page.nextCursor, total: page.total };
}

export async function readTransferPreview(deps: ServiceDeps, id: string, actor: ActorContext) {
  if (!actor.userId) throw new UnauthorizedError('Sign in to view an invitation');
  const transfer = await deps.repositories.entitlements.getTicketTransfer(id);
  const recipient = await deps.repositories.users.getById(actor.userId);
  const emailHash = recipient?.emailVerified
    ? createHash('sha256').update(recipient.email.trim().toLowerCase()).digest('hex')
    : null;
  if (
    !transfer ||
    !emailHash ||
    (transfer.recipientEmailHash
      ? transfer.recipientEmailHash !== emailHash
      : transfer.recipientUserId !== actor.userId)
  )
    throw new NotFoundError('Ticket invitation', id);
  const ticket = await deps.repositories.entitlements.getById(transfer.entitlementId);
  if (!ticket) throw new NotFoundError('Ticket invitation', id);
  const [event, profile] = await Promise.all([
    deps.repositories.events.getById(ticket.eventId),
    deps.repositories.guestProfiles.getByUserId(transfer.senderUserId),
  ]);
  const status =
    transfer.status === 'pending' &&
    Date.parse(transfer.expiresAt) <= deps.config.clock.now().getTime()
      ? ('expired' as const)
      : transfer.status;
  let reason =
    status !== 'pending' ? `This invitation is ${status}.` : unavailableReason(deps, ticket, event);
  if (
    !reason &&
    (currentEntitlementHolderId(ticket) === actor.userId ||
      ticket.pendingTransferId !== transfer.id)
  )
    reason = 'This invitation is no longer available.';
  if (!reason) {
    const cover = await deps.repositories.eventCoverAccounts?.getByEntitlement(ticket.id);
    if (cover && (cover.status !== 'active' || cover.reservedPaise > 0))
      reason = 'Transfer is unavailable while event cover is reserved or frozen.';
  }
  return {
    id: transfer.id,
    status,
    expiresAt: transfer.expiresAt,
    eventTitle: event?.title ?? 'Event details unavailable',
    startsAt: event?.startAt ?? null,
    tierName: ticket.tierName,
    senderName: profile?.displayName ?? 'A C1RCLE guest',
    canAccept: reason === null,
    unavailableReason: reason,
  };
}
