import {
  checkoutQuoteRequestSchema,
  checkoutQuoteResponseSchema,
  checkoutHoldRequestSchema,
  checkoutHoldResponseSchema,
  idempotencyKeySchema,
} from '@c1rcle/contracts/client';
import { EventNotFoundError } from '@c1rcle/core/domain';
import { z } from 'zod';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 checkout slice (Phase 4, PR2) ────────────────────────────────────────
 * Guest checkout: quote (pure calculation) -> hold (reserves inventory).
 * Thin routes — validate -> build actor -> call `CheckoutService` -> serialize.
 * No `requirePermission`: checkout is guest/session-only, never org-scoped —
 * `createHold` takes the event's organization explicitly rather than reading
 * it off the actor (see `services.actor(request)`'s "session-only actor").
 */

const services = createV2Services();

const checkoutHoldHeaders = z.looseObject({
  'idempotency-key': idempotencyKeySchema,
});

/**
 * `validateV2`'s header schema already requires this field before the
 * handler runs — this narrows the type without a bare `!`/`as` assertion,
 * and doubles as a defensive guard if that invariant is ever loosened.
 */
function requiredIdempotencyKey(v2Headers: Record<string, string> | undefined): string {
  const key = v2Headers?.['idempotency-key'];
  if (!key) throw new Error('Idempotency-Key header missing after validation');
  return key;
}

export default async function checkoutRoutes(fastify: FastifyInstance) {
  // ── QUOTE ─────────────────────────────────────────────────────────────────
  // Pure calculation, no inventory hold, no Idempotency-Key required.
  fastify.post(
    '/checkout/quote',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: checkoutQuoteRequestSchema }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof checkoutQuoteRequestSchema>;
      const actor = services.actor(request);
      const result = await services.checkout
        .quote({
          actor,
          eventId: body.eventId,
          lines: body.lines,
          promoCode: body.promoCode ?? null,
          referralCode: body.referralCode ?? null,
        })
        .catch((error: unknown) => mapDomainError(reply, request, body.eventId, error));
      if (result === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        checkoutQuoteResponseSchema,
        result.pricing,
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── CREATE HOLD ──────────────────────────────────────────────────────────
  // Requires Idempotency-Key: this reserves inventory (a write).
  fastify.post(
    '/checkout/holds',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: checkoutHoldRequestSchema, headers: checkoutHoldHeaders }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof checkoutHoldRequestSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const idempotencyKey = requiredIdempotencyKey(v2Headers);

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'checkout.hold',
        idempotencyKey,
        context: { path: {}, body },
        run: async () => {
          const event = await services.repos().events.getById(body.eventId);
          if (!event) throw new EventNotFoundError(body.eventId);

          const { pricing, attribution } = await services.checkout.quote({
            actor,
            eventId: body.eventId,
            lines: body.lines,
            promoCode: body.promoCode ?? null,
            referralCode: body.referralCode ?? null,
          });

          const hold = await services.checkout.createHold({
            actor,
            eventId: body.eventId,
            organizationId: event.organizationId,
            lines: pricing.lines.map((line) => ({
              tierId: line.tierId,
              tierName: line.tierName,
              quantity: line.quantity,
              unitPricePaise: line.unitPricePaise,
            })),
            pricing,
            appliedPromoCode: pricing.appliedPromoCode,
            attribution,
            idempotencyKey,
          });

          const payload = {
            holdId: hold.id,
            expiresAt: hold.expiresAt,
            status: hold.status,
            pricing: hold.pricing,
            convertedOrderId: hold.convertedOrderId,
          };
          const validated = validateV2Response(reply, request, checkoutHoldResponseSchema, payload);
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, body.eventId, error, {
            conflictId: idempotencyKey,
          });
        }
        return mapDomainError(reply, request, body.eventId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}
