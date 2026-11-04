import { createHash } from 'node:crypto';

import type { Entitlement } from './entitlement.js';
import type { Event } from './event.js';
import type { Order } from './order.js';

export function refundReviewTicketId(userId: string, entitlementId: string): string {
  return `SUP-REF-${createHash('sha256').update(`${userId}:${entitlementId}`).digest('hex').slice(0, 32)}`;
}

/** A request grants human review only; it never authorizes a provider refund. */
export function refundReviewEligibility(
  event: Event,
  order: Order,
  ticket: Entitlement,
  userId: string,
  now: Date,
): { allowed: boolean; reason: string | null } {
  const deny = (reason: string) => ({ allowed: false, reason });
  if (order.userId !== userId || ticket.orderId !== order.id || ticket.eventId !== event.id)
    return deny('Only the purchaser can request this refund.');
  if (
    ticket.unitKind === 'free_rsvp' ||
    ticket.orderId.startsWith('RSVP-') ||
    order.grandTotalPaise === 0
  )
    return deny('Free RSVPs can be cancelled instead.');
  if (order.status !== 'paid' || ticket.refundLock)
    return deny('A refund is already being reviewed or this order is unavailable.');
  if (ticket.status !== 'valid' || ticket.scanCount > 0)
    return deny('Refund requests are available for unused tickets.');
  const materialChange =
    Number.isFinite(Date.parse(event.lastMaterialChangeAt ?? '')) &&
    Date.parse(order.createdAt) <= Date.parse(event.lastMaterialChangeAt ?? '');
  if (event.status === 'cancelled' || event.status === 'postponed' || materialChange)
    return { allowed: true, reason: null };
  const policy = event.refundPolicy ?? { kind: 'organizer_reviewed' as const };
  if (policy.kind === 'no_refunds') return deny('This event does not accept refund requests.');
  if (
    policy.kind === 'until_cutoff' &&
    (!Number.isFinite(Date.parse(policy.cutoffAt ?? '')) ||
      now.getTime() >= Date.parse(policy.cutoffAt ?? ''))
  )
    return deny('The refund-request deadline has passed.');
  return { allowed: true, reason: null };
}
