import { createHmac, timingSafeEqual } from 'node:crypto';

import { buildV2ErrorResponse } from '@c1rcle/contracts';
import { z } from 'zod';

import type { ActorContext } from '@c1rcle/core/application';

import { getGatewayConfig } from '../../../config/index.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── V2 Razorpay webhook (Phase 4, PR2 — the security-critical route) ───────
 *
 * D-022 (docs/architecture/decisions.md): HMAC-SHA256 verification is NOT
 * optional. This route:
 *
 *  1. Fails closed at request time if `RAZORPAY_WEBHOOK_SECRET` is not
 *     configured — it does NOT fall back to `v2-services.ts`'s
 *     `paymentProvider`, which substitutes a well-known dev placeholder
 *     (`'test_webhook_secret'`) when the env var is unset so the memory
 *     driver can boot without real credentials. Reusing that instance here
 *     would silently accept a signature computed with a *public* fallback
 *     secret in a misconfigured production deploy — this route reads
 *     `RAZORPAY_WEBHOOK_SECRET` directly and refuses to proceed without it.
 *  2. Captures the exact raw bytes of the request body via a content-type
 *     parser scoped to this route only (an encapsulated child context — see
 *     Fastify's plugin-encapsulation docs) so HMAC verification runs over
 *     the byte-exact payload, never a re-serialized copy (JSON key order /
 *     whitespace changes would break the signature).
 *  3. Verifies the signature with `timingSafeEqual` BEFORE touching any
 *     service — an invalid signature gets a flat-envelope 400 and nothing
 *     else happens.
 *  4. Calls `CheckoutService.confirmPayment`, which is itself idempotent on
 *     `paymentId` (see checkout-service.ts) — a Razorpay retry of the same
 *     event, or a race against the client-redirect confirmation path, both
 *     converge on one order. That is the "idempotent claim" D-022 asks for;
 *     there is no client-supplied Idempotency-Key on a webhook to hang the
 *     generic `IdempotencyService` off of, so the anchor is the provider's
 *     own `paymentId` instead.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Raw request body bytes, captured for HMAC verification. Webhook-route only. */
    rawBody?: string;
  }
}

const services = createV2Services();

/** Deliberately permissive — this is Razorpay's payload, not ours to constrain tightly. */
const webhookPayloadSchema = z.object({
  event: z.string(),
  payload: z
    .object({
      payment: z
        .object({
          entity: z.object({
            id: z.string().min(1),
            order_id: z.string().min(1).nullable().optional(),
            amount: z.number().optional(),
            status: z.string().optional(),
            notes: z.record(z.string(), z.unknown()).optional(),
          }),
        })
        .optional(),
    })
    .optional(),
});

/** A fixed system actor — this is Razorpay calling, not a user session. HMAC is the auth. */
const WEBHOOK_ACTOR: ActorContext = {
  userId: 'system:razorpay-webhook',
  organizationId: '',
  role: 'member',
  capabilities: [],
};

function sendFlatError(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: 'validation' | 'server',
  message: string,
): FastifyReply {
  return reply.status(status).send(
    buildV2ErrorResponse({
      status,
      code,
      message,
      requestId: request.id,
    }),
  );
}

export default async function webhookRoutes(fastify: FastifyInstance) {
  // Encapsulated child context: this custom content-type parser shadows the
  // default JSON parser ONLY for routes registered inside this `register`
  // call — every other V2 route keeps Fastify's normal JSON parsing.
  await fastify.register(async (scoped) => {
    scoped.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (request: FastifyRequest, body: string, done) => {
        request.rawBody = body;
        if (body.length === 0) {
          done(null, {});
          return;
        }
        try {
          done(null, JSON.parse(body));
        } catch {
          // Malformed JSON — let the handler see an empty body and fail the
          // signature/shape check below rather than throwing out of the parser.
          done(null, {});
        }
      },
    );

    scoped.post('/webhooks/payments/razorpay', async (request, reply) => {
      const gw = getGatewayConfig();

      // (1) Fail closed — never verify against a substituted dev secret.
      if (!gw.RAZORPAY_WEBHOOK_SECRET) {
        request.log.error('razorpay_webhook_secret_not_configured');
        return sendFlatError(reply, request, 503, 'server', 'Webhook receiver is not configured');
      }

      const signatureHeader = request.headers['x-razorpay-signature'];
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
      const rawBody = request.rawBody ?? '';

      if (!signature) {
        return sendFlatError(reply, request, 400, 'validation', 'Missing webhook signature');
      }

      // (3) HMAC-SHA256 over the raw, byte-exact body — constant-time compare.
      const expected = createHmac('sha256', gw.RAZORPAY_WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');
      const expectedBuf = Buffer.from(expected, 'utf8');
      const providedBuf = Buffer.from(signature, 'utf8');
      const signatureValid =
        expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);

      if (!signatureValid) {
        request.log.warn('razorpay_webhook_signature_mismatch');
        return sendFlatError(reply, request, 400, 'validation', 'Invalid webhook signature');
      }

      const parsed = webhookPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        // Signature was valid but the shape wasn't what we expect — ack with
        // 200 so Razorpay does not retry-storm an event type we don't model,
        // but never call into fulfillment with an unparsed payload.
        request.log.warn({ event: request.body }, 'razorpay_webhook_unrecognized_payload');
        return reply.status(200).send({ received: true });
      }

      const entity = parsed.data.payload?.payment?.entity;
      if (parsed.data.event !== 'payment.captured' || !entity) {
        // Ack, no-op: only payment.captured triggers fulfillment.
        return reply.status(200).send({ received: true });
      }

      const holdIdNote = entity.notes?.holdId;
      const holdId = typeof holdIdNote === 'string' ? holdIdNote : undefined;
      const paymentIntentId = entity.order_id ?? undefined;

      if (!holdId || !paymentIntentId) {
        request.log.error({ entity }, 'razorpay_webhook_missing_correlation_ids');
        return sendFlatError(
          reply,
          request,
          400,
          'validation',
          'Webhook payload is missing hold/order correlation',
        );
      }

      // (4) Idempotent claim: confirmPayment converges on `entity.id`
      // (paymentId) regardless of how many times this event is retried, or
      // whether the client-redirect path already confirmed the same payment.
      const result = await services.checkout
        .confirmPayment({
          actor: WEBHOOK_ACTOR,
          paymentId: entity.id,
          paymentIntentId,
          holdId,
          _idempotencyKey: entity.id,
        })
        .catch((error: unknown) => mapDomainError(reply, request, holdId, error));
      if (result === undefined) return reply;

      return reply.status(200).send({ received: true });
    });
  });
}
