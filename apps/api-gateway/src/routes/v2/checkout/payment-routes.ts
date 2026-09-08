import {
  paymentAttemptRequestSchema,
  paymentAttemptResponseSchema,
  paymentConfirmRequestSchema,
  paymentConfirmResponseSchema,
  idempotencyKeySchema,
} from '@c1rcle/contracts/client';
import { InvalidOperationError } from '@c1rcle/core/domain';
import { z } from 'zod';

import { getGatewayConfig } from '../../../config/index.js';
import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { orderToDto } from '../orders/order-dto.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 payments slice (Phase 4, PR2) ────────────────────────────────────────
 * `POST /payments/attempts` creates the provider intent for a hold;
 * `POST /payments/:id/verify` is the client-redirect confirmation path — it
 * verifies the provider signature *before* ever calling `confirmPayment`
 * (the webhook path, verified independently, is `webhook-routes.ts`). Both
 * paths converge on the same idempotent `CheckoutService.confirmPayment`.
 */

const services = createV2Services();

const paymentAttemptHeaders = z.looseObject({
  'idempotency-key': idempotencyKeySchema,
});

const paymentIdParam = z.object({ id: z.string().min(3).max(64) });

const paymentVerifyHeaders = z.looseObject({
  'idempotency-key': idempotencyKeySchema.optional(),
});

/**
 * `validateV2`'s header schema already requires this field for `paymentAttemptHeaders`
 * before the handler runs — this narrows the type without a bare `!`/`as` assertion.
 */
function requiredIdempotencyKey(v2Headers: Record<string, string> | undefined): string {
  const key = v2Headers?.['idempotency-key'];
  if (!key) throw new Error('Idempotency-Key header missing after validation');
  return key;
}

export default async function paymentRoutes(fastify: FastifyInstance) {
  // ── CREATE PAYMENT ATTEMPT ──────────────────────────────────────────────
  fastify.post(
    '/payments/attempts',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          body: paymentAttemptRequestSchema,
          headers: paymentAttemptHeaders,
        }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof paymentAttemptRequestSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const idempotencyKey = requiredIdempotencyKey(v2Headers);

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'payment.attempt',
        idempotencyKey,
        context: { path: {}, body },
        run: async () => {
          const intent = await services.checkout.createPaymentIntent({
            actor,
            holdId: body.holdId,
            idempotencyKey,
          });
          const gw = getGatewayConfig();
          const payload = {
            paymentIntentId: intent.paymentIntentId,
            amountPaise: intent.amountPaise,
            keyId: gw.RAZORPAY_KEY_ID,
          };
          const validated = validateV2Response(
            reply,
            request,
            paymentAttemptResponseSchema,
            payload,
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, body.holdId, error, { conflictId: idempotencyKey });
        }
        return mapDomainError(reply, request, body.holdId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── VERIFY (client-redirect confirmation) ───────────────────────────────
  // Not folded into `runIdempotent`'s REQUIRED-key path: `confirmPayment` is
  // self-idempotent on `paymentId` (see checkout-service.ts), so a missing
  // Idempotency-Key here is a correctness bonus, never a server requirement —
  // unlike `/checkout/holds` and `/payments/attempts`, which mutate on a
  // client-chosen id with no other anchor.
  fastify.post(
    '/payments/:id/verify',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: paymentIdParam,
          body: paymentConfirmRequestSchema,
          headers: paymentVerifyHeaders,
        }),
      ],
    },
    async (request, reply) => {
      const { id: paymentId } = request.params as z.infer<typeof paymentIdParam>;
      const body = request.body as z.infer<typeof paymentConfirmRequestSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const idempotencyKey = v2Headers['idempotency-key'];

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'payment.verify',
        idempotencyKey,
        context: { path: { id: paymentId }, body },
        run: async () => {
          // Signature verification happens BEFORE confirmPayment is ever
          // called — an invalid/forged signature never reaches fulfillment.
          const verification = await services.paymentProvider.verifyPayment({
            paymentId,
            orderId: body.paymentIntentId,
            signature: body.signature,
          });
          if (!verification.captured) {
            throw new InvalidOperationError(`Payment ${paymentId} has not been captured`);
          }

          const { order, entitlements } = await services.checkout.confirmPayment({
            actor,
            paymentId,
            paymentIntentId: body.paymentIntentId,
            holdId: body.holdId,
            _idempotencyKey: idempotencyKey ?? paymentId,
          });

          const payload = { order: orderToDto(order), entitlements };
          const validated = validateV2Response(
            reply,
            request,
            paymentConfirmResponseSchema,
            payload,
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, paymentId, error, { conflictId: idempotencyKey });
        }
        return mapDomainError(reply, request, paymentId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}
