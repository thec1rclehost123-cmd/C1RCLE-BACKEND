import type { EventHandler } from '@c1rcle/core/application';

/** Canonical V1 event producers that are allowed to create transactional email intents. */
export const TRANSACTIONAL_EMAIL_EVENT_TYPES = [
  'order.fulfilled',
  'ticket.issued',
  'ticket.transfer.created',
  'ticket.transfer.invitation_resent',
  'ticket.transfer.resolved',
  'payment.support_required',
  'finance.refund.settled',
  'finance.refund.finalized',
  'finance.payout.status_changed',
  'event.cancellation.order_affected',
  'event.cancellation.email_requested',
  'event.updated',
  'event.material_change.batch_requested',
  'event.material_change.order_affected',
  'event.material_change.refund_requested',
  'partner.onboarding.email_requested',
  'promoter.assignment.invited',
  'promoter.assignment.accepted',
  'promoter.assignment.rejected',
  'promoter.assignment.revoked',
  'promoter.assignment.expired',
  'promoter.assignments.status_changed',
  'event-cover.redeemed',
  'event-cover.reversed',
  'event-cover.refunded',
  'ticket.addon.redeemed',
] as const;

export interface EventSubscriber {
  subscribe(type: string, handler: EventHandler): void;
}

export function subscribeTransactionalEmailConsumer(
  eventBus: EventSubscriber,
  consumer: EventHandler,
): void {
  for (const type of TRANSACTIONAL_EMAIL_EVENT_TYPES) eventBus.subscribe(type, consumer);
}
