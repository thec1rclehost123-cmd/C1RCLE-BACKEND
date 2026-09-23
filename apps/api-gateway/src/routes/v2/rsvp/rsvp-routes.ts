import {
  idempotencyKeySchema,
  rsvpRequestSchema,
  rsvpResponseSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { orderToDto } from '../orders/order-dto.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 RSVP slice ───────────────────────────────────────────────────────────
 * `POST /rsvp` — direct free-ticket booking for `isFree` events with a
 * zero-price tier. One call fulfills immediately: no quote, no hold, no
 * Razorpay intent/verify. Quantity is fixed at 1 server-side and one RSVP
 * per user per event is enforced by a deterministic order id
 * (`CheckoutService.createRsvp`) — a sequential second RSVP is a 409, while
 * a concurrent double-tap converges on the winner.
 *
 * Thin route — validate -> build actor -> call `CheckoutService` -> serialize.
 * Auth is enforced in the service (any ticket booking requires an account);
 * `Idempotency-Key` is optional here (a correctness bonus, never a server
 * requirement) because the deterministic order id already makes retries safe.
 */

const services = createV2Services();

const rsvpHeaders = z.looseObject({
  'idempotency-key': idempotencyKeySchema.optional(),
});

export default async function rsvpRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/rsvp',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: rsvpRequestSchema, headers: rsvpHeaders }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof rsvpRequestSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const idempotencyKey = v2Headers['idempotency-key'];

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'rsvp.create',
        idempotencyKey,
        context: { path: {}, body },
        run: async () => {
          const { order, entitlements } = await services.checkout.createRsvp({
            actor,
            eventId: body.eventId,
            tierId: body.tierId,
          });
          const payload = { order: orderToDto(order), entitlements };
          const validated = validateV2Response(reply, request, rsvpResponseSchema, payload);
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
