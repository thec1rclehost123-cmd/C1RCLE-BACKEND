import {
  opaqueIdSchema,
  partnerGlobalSearchQuerySchema,
  partnerGlobalSearchResponseSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

const services = createV2Services();
const params = z.object({ organizationId: opaqueIdSchema });
const headers = z.looseObject({ 'x-organization-id': opaqueIdSchema });

/** Searches only tenant events and partner business relationships. */
export default async function partnerSearchRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/organizations/:organizationId/search',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params, querystring: partnerGlobalSearchQuerySchema, headers }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { organizationId } = request.params as z.infer<typeof params>;
      const { q } = request.query as z.infer<typeof partnerGlobalSearchQuerySchema>;
      const actor = services.actor(request);
      const result = await search(actor, organizationId, q).catch((error: unknown) =>
        mapDomainError(reply, request, organizationId, error),
      );
      if (!result) return reply;
      const validated = validateV2Response(
        reply,
        request,
        partnerGlobalSearchResponseSchema,
        result,
      );
      return validated === undefined ? reply : reply.send(validated);
    },
  );
}

async function search(
  actor: ReturnType<typeof services.actor>,
  organizationId: string,
  query: string,
) {
  await services.organizations.get(actor, organizationId);
  const needle = query.trim().toLocaleLowerCase();
  const [partnerships, connections, discoverable] = await Promise.all([
    services.partnerships.listWithNames(actor, organizationId, { limit: 100, cursor: null }),
    services.promoterConnections.listWithNames(actor, organizationId, { limit: 100, cursor: null }),
    services.discovery.discover(actor, organizationId, { q: query, limit: 12, cursor: null }),
  ]);
  const events = [];
  let eventCursor: string | null = null;
  // Search a bounded 1,000 most recently listed tenant events without building an index.
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = await services.events.list(actor, { limit: 100, cursor: eventCursor });
    events.push(...page.items);
    eventCursor = page.nextCursor;
    if (!eventCursor) break;
  }
  const results = new Map<
    string,
    { id: string; type: 'event' | 'partner'; title: string; subtitle: string }
  >();
  for (const event of events) {
    if (event.title.toLocaleLowerCase().includes(needle)) {
      results.set(`event:${event.id}`, {
        id: event.id,
        type: 'event',
        title: event.title,
        subtitle: 'Event',
      });
    }
  }
  for (const { partnership, hostName, venueName } of partnerships.items) {
    if (partnership.status !== 'active') continue;
    const isHost = partnership.hostOrganizationId === organizationId;
    const title = isHost ? venueName : hostName;
    const id = isHost ? partnership.venueId : partnership.hostOrganizationId;
    if (title && title.toLocaleLowerCase().includes(needle)) {
      results.set(`partner:${id}`, { id, type: 'partner', title, subtitle: 'Partner' });
    }
  }
  for (const { connection, promoterName, targetName } of connections.items) {
    if (connection.status !== 'active') continue;
    const isPromoter = connection.promoterId !== organizationId;
    const title = isPromoter ? promoterName : targetName;
    const id = isPromoter ? connection.promoterId : connection.targetId;
    if (title && title.toLocaleLowerCase().includes(needle)) {
      results.set(`partner:${id}`, { id, type: 'partner', title, subtitle: 'Partner' });
    }
  }
  for (const partner of discoverable.items) {
    results.set(`partner:${partner.id}`, {
      id: partner.id,
      type: 'partner',
      title: partner.name,
      subtitle: partner.kind,
    });
  }
  return {
    results: [...results.values()]
      .sort(
        (a, b) =>
          Number(!a.title.toLocaleLowerCase().startsWith(needle)) -
            Number(!b.title.toLocaleLowerCase().startsWith(needle)) ||
          a.title.localeCompare(b.title),
      )
      .slice(0, 12),
  };
}
