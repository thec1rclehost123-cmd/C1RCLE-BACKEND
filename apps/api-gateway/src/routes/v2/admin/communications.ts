import { opaqueIdSchema } from '@c1rcle/contracts/client';
import { z } from 'zod';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

const services = createV2Services();
const paramsSchema = z.object({ aggregateId: opaqueIdSchema });
const deliverySchema = z.object({
  id: opaqueIdSchema,
  aggregateId: opaqueIdSchema,
  kind: z.string().min(1),
  status: z.enum(['queued', 'sending', 'sent', 'failed']),
  retryCount: z.number().int().nonnegative(),
  providerMessageId: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  sentAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
});

/** Provider-safe email delivery evidence; recipient addresses/hashes are not returned. */
export default async function adminCommunicationRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/admin/communications/email-deliveries/:aggregateId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: paramsSchema })],
    },
    async (request, reply) => {
      const adminUserId = requireUserId(request, reply);
      if (!adminUserId) return reply;
      const { aggregateId } = request.params as z.infer<typeof paramsSchema>;
      const deliveries = await services.adminOps
        .listEmailDeliveries(adminUserId, aggregateId)
        .catch((error: unknown) => mapDomainError(reply, request, aggregateId, error));
      if (deliveries === undefined) return reply;
      const safe = deliveries.map(({ recipientHash: _recipientHash, ...record }) => record);
      const validated = validateV2Response(reply, request, z.array(deliverySchema), safe);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}
