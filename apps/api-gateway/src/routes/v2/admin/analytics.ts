import { adminAnalyticsSummaryDtoSchema } from '@c1rcle/contracts/client';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin analytics desk (Phase 7 admin) ────────────────────────────────────
 * Platform-wide revenue/ticket/event summary. Read-only, any admin — same
 * `services.adminOps.<x>` shape as every other admin read in this repo.
 * See `AdminOperationsService.getAnalyticsSummary`'s doc comment for the
 * bounded-scan reasoning (not a full-collection reduce on every request).
 */

const services = createV2Services();

export default async function adminAnalyticsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/admin/analytics',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({})],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;

      const summary = await services.adminOps
        .getAnalyticsSummary(userId)
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (summary === undefined) return reply;

      const validated = validateV2Response(reply, request, adminAnalyticsSummaryDtoSchema, summary);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}
