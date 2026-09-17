import {
  opaqueIdSchema,
  discoverPartnerDtoSchema,
  discoverPartnersQuerySchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 partner discovery slice ─────────────────────────────────────────────
 * `GET /organizations/:organizationId/discover-partners`: real
 * organizations/venues the caller could connect with. The dashboard's
 * Discover tab called this path long before the route existed and read every
 * 404 as "no partners" — the tab was empty by construction, never by data.
 */

const services = createV2Services();

const organizationIdParam = z.object({ organizationId: opaqueIdSchema });

const discoverListSchema = paginatedSchema(discoverPartnerDtoSchema);

export default async function partnerDiscoveryRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/organizations/:organizationId/discover-partners',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: organizationIdParam,
          querystring: discoverPartnersQuerySchema,
          headers: z.looseObject({ 'x-organization-id': opaqueIdSchema }),
        }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const query = request.query as z.infer<typeof discoverPartnersQuerySchema>;
      const actor = services.actor(request);
      const page = await services.discovery
        .discover(actor, organizationId, {
          type: query.type,
          q: query.q,
          cursor: query.cursor ?? null,
          limit: query.limit,
        })
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (page === undefined) return reply;

      const payload = {
        items: page.items.map((item) => ({
          id: item.id,
          kind: item.kind,
          name: item.name,
          slug: item.slug,
          city: item.city,
          verified: item.verified,
          organizationId: item.organizationId,
          venueId: item.venueId,
        })),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, discoverListSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}
