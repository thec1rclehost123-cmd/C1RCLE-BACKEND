import {
  adminVenueDtoSchema,
  idempotencyKeySchema,
  opaqueIdSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Venue } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin venue actions (Phase 7 admin) ─────────────────────────────────────
 *
 * Venue suspension is a TIER2 direct command: the domain model grants
 * `VENUE_SUSPEND` to a single `ops`/`finance`/`admin`/`super` admin and
 * `proposeAction` refuses lower tiers (only TIER3 actions require dual
 * control). Same shape as `payouts.ts`'s `batch-run` — idempotent, and
 * audited with before/after by `AdminOperationsService.suspendVenue`. A
 * repeat suspend of an already-suspended venue is a no-op returning 200.
 */

const services = createV2Services();

const venueIdParam = z.object({ venueId: opaqueIdSchema });
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });

function venueToDto(venue: Venue) {
  return {
    id: venue.id,
    organizationId: venue.organizationId,
    name: venue.public.name,
    slug: venue.public.slug,
    city: venue.public.address.city ?? null,
    status: venue.status,
    capacity: venue.public.capacity ?? null,
    createdAt: venue.createdAt,
    updatedAt: venue.updatedAt,
  };
}

export default async function adminVenueActionRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/admin/venues/:venueId/suspend',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: venueIdParam, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { venueId } = request.params as z.infer<typeof venueIdParam>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.venue.suspend',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { venueId }, body: {} },
        run: async () => {
          const venue = await services.adminOps.suspendVenue(userId, venueId);
          const validated = validateV2Response(
            reply,
            request,
            adminVenueDtoSchema,
            venueToDto(venue),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, venueId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, venueId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}
