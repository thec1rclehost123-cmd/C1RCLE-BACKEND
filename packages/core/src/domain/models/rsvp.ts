import { ConflictError, InvalidOperationError, NotFoundError } from '../errors.js';
import { bumpVersion } from '../identity.js';

import { eventAdmissionClosesAt } from './event-policy.js';
import { committedTierQuantity } from './tier-inventory.js';

import type { CartReservation } from './cart-reservation.js';
import type { Entitlement } from './entitlement.js';
import type { TicketTier } from './event-catalog.js';
import type { Event } from './event.js';
import type { Order } from './order.js';
import type { RsvpAcquisition } from '../ports/repositories.js';

/** Runs inside the inventory transaction, against current persisted state. */
export function assertRsvpCapacity(
  input: RsvpAcquisition,
  event: Event | null,
  tier: TicketTier | null,
  orders: Pick<Order, 'status' | 'lines' | 'refundedTicketClaims'>[],
  holds: Pick<CartReservation, 'status' | 'expiresAt' | 'lines'>[],
) {
  const line = input.order.lines[0];
  if (
    !event ||
    !tier ||
    !line ||
    event.id !== input.order.eventId ||
    tier.eventId !== event.id ||
    tier.organizationId !== input.order.organizationId ||
    line.tierId !== tier.id ||
    input.order.lines.length !== 1 ||
    line.quantity !== 1 ||
    input.order.grandTotalPaise !== 0 ||
    input.order.status !== 'paid' ||
    !input.order.userId ||
    !input.order.id.startsWith('RSVP-') ||
    input.entitlements.length !== 1 ||
    input.entitlements[0]?.orderId !== input.order.id
  )
    throw new InvalidOperationError('Invalid RSVP allocation');
  if (event.version !== input.expectedEventVersion || tier.version !== input.expectedTierVersion)
    throw new ConflictError('Event or ticket tier changed; refresh before booking');
  if (
    event.status !== 'published' ||
    tier.status !== 'active' ||
    (tier.priceInPaise ?? tier.doorPriceInPaise ?? 0) !== 0 ||
    (tier.guestCount ?? 1) > 1 ||
    tier.admissionMode === 'per_person'
  )
    throw new InvalidOperationError('This RSVP is not available');
  if (
    (tier.salesStartAt &&
      (!Number.isFinite(Date.parse(tier.salesStartAt)) ||
        input.now.getTime() < Date.parse(tier.salesStartAt))) ||
    (tier.salesEndAt &&
      (!Number.isFinite(Date.parse(tier.salesEndAt)) ||
        input.now.getTime() >= Date.parse(tier.salesEndAt))) ||
    !Number.isFinite(eventAdmissionClosesAt(event)) ||
    input.now.getTime() >= eventAdmissionClosesAt(event)
  )
    throw new InvalidOperationError('RSVP sales are closed');
  if (committedTierQuantity(tier.id, orders, holds, input.now) + 1 > tier.quantity)
    throw new InvalidOperationError('Insufficient inventory for this RSVP');
}

export function cancelledRsvp(
  order: Order | null,
  tickets: Entitlement[],
  userId: string,
  now: Date,
) {
  if (
    !order ||
    order.userId !== userId ||
    !order.id.startsWith('RSVP-') ||
    order.grandTotalPaise !== 0
  )
    throw new NotFoundError('RSVP', order?.id ?? '');
  if (order.status === 'cancelled') return { order, entitlements: tickets };
  if (
    order.status !== 'paid' ||
    tickets.length !== 1 ||
    tickets.some(
      (ticket) =>
        ticket.unitKind !== 'free_rsvp' ||
        ticket.status !== 'valid' ||
        ticket.scanCount !== 0 ||
        Boolean(ticket.refundLock) ||
        Boolean(ticket.pendingTransferId),
    )
  )
    throw new ConflictError('Only an unused RSVP can be cancelled');
  return {
    order: bumpVersion(
      { ...order, status: 'cancelled' as const, failureReason: 'Cancelled by RSVP holder' },
      now,
    ),
    entitlements: tickets.map((ticket) =>
      bumpVersion(
        {
          ...ticket,
          status: 'void' as const,
          credentialVersion: (ticket.credentialVersion ?? 1) + 1,
        },
        now,
      ),
    ),
  };
}
