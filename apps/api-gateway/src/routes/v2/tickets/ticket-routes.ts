import { entitlementDtoSchema } from '@c1rcle/contracts/client';
import { z } from 'zod';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Guest ticket reads (Phase 4 PR3) ──────────────────────────────────────
 * `GET /tickets/:id` — the entitlement DTO for a ticket the caller owns.
 *
 * `transfer` / `claim` / `cancel-transfer` are NOT implemented here — the
 * committed `Entitlement` model has no transfer state to wire against (see
 * `TicketService`'s doc comment). Deliberately absent (404 by absence, D-006),
 * not a fake 200 or a guessed 501: shipping those three routes needs a
 * domain-model decision first (a transfer FSM state + claim-token scheme),
 * which is a design call, not wiring.
 */

const services = createV2Services();
const ticketIdParam = z.object({ id: z.string().min(3).max(64) });

export default async function ticketRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/tickets/:id',
    { preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: ticketIdParam })] },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof ticketIdParam>;
      const actor = services.actor(request);
      const entitlement = await services.tickets
        .getById(id, actor)
        .catch((error: unknown) => mapDomainError(reply, request, id, error));
      if (entitlement === undefined) return reply;
      const validated = validateV2Response(reply, request, entitlementDtoSchema, entitlement);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}
