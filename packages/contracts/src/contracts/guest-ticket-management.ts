import { z } from 'zod';
import { guestRefundReviewDtoSchema } from './phase6.js';
import { eventStatusSchema } from './event.js';

const transferState = z.enum(['pending', 'accepted', 'declined', 'cancelled', 'expired', 'frozen']);
export const managedTicketSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  eventId: z.string(),
  eventStatus: eventStatusSchema.nullable(),
  tierId: z.string(),
  tierName: z.string(),
  holderName: z.string().nullable(),
  ownership: z.enum(['you', 'unassigned', 'transferred']),
  unitKind: z.enum(['paid', 'free_rsvp', 'complimentary']),
  status: z.enum(['active', 'used', 'cancelled', 'refund_pending', 'refunded']),
  eventTitle: z.string(),
  eventSlug: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  posterUrl: z.string().nullable(),
  bookingReference: z.string().nullable(),
  canRequestRefund: z.boolean(),
  refundUnavailableReason: z.string().nullable(),
  refundReview: guestRefundReviewDtoSchema.nullable(),
  canPresent: z.boolean(),
  qrUnavailableReason: z.string().nullable(),
  venueId: z.string().nullable(),
  venueName: z.string().nullable(),
  venueCity: z.string().nullable(),
  canTransfer: z.boolean(),
  transferUnavailableReason: z.string().nullable(),
  pendingTransfer: z
    .object({ id: z.string(), status: transferState, expiresAt: z.string() })
    .nullable(),
});
export const managedTicketListSchema = z.object({
  items: z.array(managedTicketSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
});
export const ticketTransferPreviewSchema = z.object({
  id: z.string(),
  status: transferState,
  expiresAt: z.string(),
  eventTitle: z.string(),
  startsAt: z.string().nullable(),
  tierName: z.string(),
  senderName: z.string(),
  canAccept: z.boolean(),
  unavailableReason: z.string().nullable(),
});
export type ManagedTicket = z.infer<typeof managedTicketSchema>;
export type TicketTransferPreview = z.infer<typeof ticketTransferPreviewSchema>;
