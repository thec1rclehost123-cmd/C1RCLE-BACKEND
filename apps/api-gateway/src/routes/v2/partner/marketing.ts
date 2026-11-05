import {
  ticketTierPerformanceSchema,
  marketingAudienceQuerySchema,
  marketingAudienceSchema,
} from '@c1rcle/contracts/partner-marketing';
import { PartnerMarketingService } from '@c1rcle/core/partner-marketing';
import { z } from 'zod';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

export default async function partnerMarketingRoutes(app: FastifyInstance) {
  const services = createV2Services();
  const service = new PartnerMarketingService(services.repos());
  app.get(
    '/organizations/:organizationId/analytics/ticket-tiers',
    {
      preHandler: [
        app.rateLimit('AUTH_READ'),
        app.validateV2({
          params: z.object({ organizationId: z.string().min(1).max(128) }),
          querystring: z.object({
            from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          }),
        }),
        app.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { organizationId } = request.params as { organizationId: string };
      const { from, to } = request.query as { from: string; to: string };
      try {
        const result = validateV2Response(
          reply,
          request,
          ticketTierPerformanceSchema,
          await service.tierPerformance(organizationId, services.actor(request), from, to),
        );
        return await (result === undefined ? reply : reply.send(result));
      } catch (error) {
        return mapDomainError(reply, request, organizationId, error);
      }
    },
  );
  app.get(
    '/organizations/:organizationId/marketing/audience',
    {
      preHandler: [
        app.rateLimit('AUTH_READ'),
        app.validateV2({
          params: z.object({ organizationId: z.string().min(1).max(128) }),
          querystring: marketingAudienceQuerySchema,
        }),
        app.requirePermission('finance.orders.read'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { organizationId } = request.params as { organizationId: string };
      try {
        const data = await service.list(
          organizationId,
          services.actor(request),
          marketingAudienceQuerySchema.parse(request.query),
        );
        const result = validateV2Response(reply, request, marketingAudienceSchema, data);
        return await (result === undefined ? reply : reply.send(result));
      } catch (error) {
        return mapDomainError(reply, request, organizationId, error);
      }
    },
  );
}
