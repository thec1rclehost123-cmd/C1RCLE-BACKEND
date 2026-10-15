import { z } from 'zod';

import type { ProviderDisputeStatus, ProviderPaymentEvent } from '@c1rcle/core/domain';

/**
 * Razorpay's payload, not ours to constrain tightly: only the fields the
 * gateway acts on are modelled, and unknown keys are stripped on parse so the
 * parsed value never carries the payer's personal data any further.
 *
 * `notes` is an object when the order set any and an EMPTY ARRAY when it set
 * none; a payment link or an order created elsewhere has no notes at all.
 * Treating the array as a parse failure would drop an otherwise valid event.
 */
export const webhookPayloadSchema = z.object({
  event: z.string(),
  payload: z
    .object({
      payment: z
        .object({
          entity: z.object({
            id: z.string().min(1),
            order_id: z.string().min(1).nullable().optional(),
            amount: z.number().optional(),
            currency: z.string().length(3).optional(),
            /** The provider's own fee and the tax on it, in paise. Null until captured. */
            fee: z.number().nullable().optional(),
            tax: z.number().nullable().optional(),
            status: z.string().optional(),
            notes: z
              .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
              .nullable()
              .optional(),
          }),
        })
        .optional(),
      refund: z
        .object({
          entity: z.object({
            id: z.string().min(1),
            payment_id: z.string().min(1),
            amount: z.number(),
            currency: z.string().length(3).optional(),
          }),
        })
        .optional(),
      dispute: z
        .object({
          entity: z.object({
            id: z.string().min(1),
            payment_id: z.string().min(1),
            amount: z.number(),
            currency: z.string().length(3).optional(),
          }),
        })
        .optional(),
    })
    .optional(),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

/** The `holdId` note, if the order carried one. Arrays and `null` mean "no notes". */
export function holdIdFromNotes(notes: unknown): string | undefined {
  if (notes === null || typeof notes !== 'object' || Array.isArray(notes)) return undefined;
  const holdId = (notes as Record<string, unknown>).holdId;
  return typeof holdId === 'string' && holdId.length > 0 ? holdId : undefined;
}

/** What is safe to write to a log about a webhook event: identifiers only. */
export interface WebhookLogSummary {
  event?: string;
  paymentId?: string;
  orderId?: string;
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * Reduces ANY webhook body (parsed or not) to its event name and the payment and
 * order identifiers. A Razorpay payment entity carries the payer's name, email,
 * phone number and card details, so the entity itself must never be logged,
 * including when the body fails validation and its shape is unknown.
 */
export function summariseWebhookForLog(body: unknown): WebhookLogSummary {
  if (body === null || typeof body !== 'object') return {};
  const root = body as Record<string, unknown>;
  const payload = root.payload as Record<string, unknown> | undefined;
  const payment = payload?.payment as Record<string, unknown> | undefined;
  const entity = payment?.entity as Record<string, unknown> | undefined;
  const summary: WebhookLogSummary = {};
  const event = asString(root.event);
  const paymentId = asString(entity?.id);
  const orderId = asString(entity?.order_id);
  if (event) summary.event = event;
  if (paymentId) summary.paymentId = paymentId;
  if (orderId) summary.orderId = orderId;
  return summary;
}

const DISPUTE_STATUS_BY_EVENT: Record<string, ProviderDisputeStatus> = {
  'payment.dispute.created': 'open',
  'payment.dispute.action_required': 'open',
  'payment.dispute.under_review': 'under_review',
  'payment.dispute.won': 'won',
  'payment.dispute.lost': 'lost',
  'payment.dispute.closed': 'closed',
};

/**
 * The provider fact a webhook event carries, or null when it carries none we
 * record. `orderId` is our order for a capture that has been fulfilled.
 */
export function providerEventFromWebhook(
  webhook: WebhookPayload,
  orderId: string | null,
  now: Date,
  correlated = orderId !== null,
): ProviderPaymentEvent | null {
  const payload = webhook.payload;
  if (webhook.event === 'payment.captured') {
    const payment = payload?.payment?.entity;
    if (!payment || payment.amount === undefined) return null;
    return {
      type: 'captured',
      paymentId: payment.id,
      providerOrderId: payment.order_id ?? null,
      orderId,
      correlated,
      amountPaise: payment.amount,
      currency: payment.currency ?? 'INR',
      feePaise: payment.fee ?? 0,
      taxOnFeePaise: payment.tax ?? 0,
      occurredAt: now.toISOString(),
    };
  }
  if (webhook.event === 'refund.processed') {
    const refund = payload?.refund?.entity;
    if (!refund) return null;
    return {
      type: 'refund_processed',
      paymentId: refund.payment_id,
      refundId: refund.id,
      amountPaise: refund.amount,
      currency: refund.currency ?? 'INR',
    };
  }
  const status = DISPUTE_STATUS_BY_EVENT[webhook.event];
  const dispute = payload?.dispute?.entity;
  if (status && dispute) {
    return {
      type: 'dispute',
      paymentId: dispute.payment_id,
      disputeId: dispute.id,
      amountPaise: dispute.amount,
      currency: dispute.currency ?? 'INR',
      status,
    };
  }
  return null;
}
