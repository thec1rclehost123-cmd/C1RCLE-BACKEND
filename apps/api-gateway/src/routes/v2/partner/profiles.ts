import { opaqueIdSchema, partnerPublicProfileDtoSchema } from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Event } from '@c1rcle/core/domain';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

const services = createV2Services();
const params = z.object({ organizationId: opaqueIdSchema, partnerId: opaqueIdSchema });
const query = z.object({ kind: z.enum(['host', 'venue', 'promoter']) });
const headers = z.looseObject({ 'x-organization-id': opaqueIdSchema });

export default async function partnerProfileRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/organizations/:organizationId/partner-profiles/:partnerId',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params, querystring: query, headers }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { organizationId, partnerId } = request.params as z.infer<typeof params>;
      const { kind } = request.query as z.infer<typeof query>;
      const actor = services.actor(request);
      const viewer = await services.organizations
        .get(actor, organizationId)
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (!viewer) return reply;
      if (partnerId === organizationId)
        return reply.status(404).send({ code: 'not_found', message: 'Partner profile not found.' });

      const repos = services.repos();
      let resolvedPartnerId = partnerId;
      if (kind === 'venue' && !(await repos.venues.getById(resolvedPartnerId))) {
        const partnership = await repos.partnerships.getById(partnerId);
        const connection = partnership ? null : await repos.promoterConnections.getById(partnerId);
        if (partnership) resolvedPartnerId = partnership.venueId;
        else if (connection?.targetType === 'venue') {
          const directVenue = await repos.venues.getById(connection.targetId);
          if (directVenue) resolvedPartnerId = directVenue.id;
          else {
            const ownerVenues = await repos.venues.listByOrganization(connection.targetId, {
              limit: 100,
              cursor: null,
            });
            resolvedPartnerId = ownerVenues.items[0]?.id ?? connection.targetId;
          }
        }
      } else if (kind === 'host' && !(await repos.organizations.getById(resolvedPartnerId))) {
        const partnership = await repos.partnerships.getById(partnerId);
        const connection = partnership ? null : await repos.promoterConnections.getById(partnerId);
        if (partnership) resolvedPartnerId = partnership.hostOrganizationId;
        else if (connection?.targetType === 'host') resolvedPartnerId = connection.targetId;
      } else if (kind === 'promoter' && !(await repos.organizations.getById(resolvedPartnerId))) {
        const connection = await repos.promoterConnections.getById(partnerId);
        if (connection) resolvedPartnerId = connection.promoterId;
      }
      if (resolvedPartnerId === organizationId)
        return reply.status(404).send({ code: 'not_found', message: 'Partner profile not found.' });
      let profile: {
        id: string;
        name: string;
        slug: string;
        kind: 'host' | 'venue' | 'promoter';
        city: string | null;
        bio: string;
        photoUrl: string | null;
        coverUrl: string | null;
        genres: string[];
        venue: null | {
          capacity: number | null;
          facilities: string[];
          address: Record<string, string | undefined>;
        };
        events: Event[];
        memberSince: string;
        organizationId: string;
        eventCount: number;
      } | null = null;

      if (kind === 'venue') {
        const venue = await repos.venues.getById(resolvedPartnerId);
        const owner = venue ? await repos.organizations.getById(venue.organizationId) : null;
        if (
          venue?.status === 'active' &&
          owner?.status === 'active' &&
          (owner.settings.partnerPrivacy?.profileVisible ?? true)
        ) {
          const result = await repos.events.listByVenue(venue.id, { limit: 100, cursor: null });
          profile = {
            id: venue.id,
            name: venue.public.name,
            slug: venue.public.slug,
            kind,
            city: venue.public.address.city ?? null,
            bio: venue.public.description,
            photoUrl: venue.public.photoUrl,
            coverUrl: venue.public.coverUrl ?? null,
            genres: venue.public.genres ?? [],
            venue: {
              capacity: venue.public.capacity,
              facilities: venue.public.facilities,
              address: {
                street: venue.public.address.street,
                city: venue.public.address.city,
                state: venue.public.address.state,
                zip: venue.public.address.zip,
                country: venue.public.address.country,
              },
            },
            events: result.items,
            eventCount: result.total,
            memberSince: venue.createdAt,
            organizationId: owner.id,
          };
        }
      } else {
        const org = await repos.organizations.getById(resolvedPartnerId);
        const member = org?.members.find((entry) => entry.capabilities.includes(kind));
        if (
          org?.status === 'active' &&
          member &&
          (org.settings.partnerPrivacy?.profileVisible ?? true)
        ) {
          const result = await repos.events.listByOrganization(org.id, {
            limit: 100,
            cursor: null,
          });
          profile = {
            id: org.id,
            name: org.settings.partnerProfile?.displayName ?? org.name,
            slug: org.slug,
            kind,
            city: org.settings.partnerProfile?.city ?? null,
            bio: org.settings.partnerProfile?.bio ?? '',
            photoUrl: org.settings.partnerProfile?.photoUrl ?? null,
            coverUrl: org.settings.partnerProfile?.coverUrl ?? null,
            genres: org.settings.partnerProfile?.genres ?? [],
            venue: null,
            events: kind === 'promoter' ? [] : result.items,
            eventCount: result.total,
            memberSince: org.createdAt,
            organizationId: org.id,
          };
        }
      }

      if (!profile)
        return reply.status(404).send({ code: 'not_found', message: 'Partner profile not found.' });
      const upcoming = profile.events
        .filter(
          (event) =>
            event.startAt >= new Date().toISOString() &&
            event.status !== 'cancelled' &&
            event.status !== 'archived' &&
            event.isPublic &&
            (event.visibilityMode === undefined || event.visibilityMode === 'public'),
        )
        .sort((left, right) => left.startAt.localeCompare(right.startAt))
        .slice(0, 6)
        .map((event) => ({
          id: event.id,
          title: event.title,
          startAt: event.startAt,
          imageUrl: event.imageUrl,
        }));

      const [partnerships, connections, overview] = await Promise.all([
        repos.partnerships.listForOrganization(profile.organizationId, {
          limit: 100,
          cursor: null,
        }),
        repos.promoterConnections.listForOrganization(profile.organizationId, {
          limit: 100,
          cursor: null,
        }),
        repos.analytics.getOrganizationOverview(profile.organizationId).catch(() => null),
      ]);
      const stats: { label: string; value: string }[] = [];
      if (kind === 'promoter') {
        const assignments = await repos.catalog.listAssignmentsByPromoter(profile.organizationId);
        const activeEvents = new Set(
          assignments
            .filter(
              (assignment) => assignment.status === 'accepted' || assignment.status === 'active',
            )
            .map((assignment) => assignment.eventId),
        );
        stats.push({ label: 'Events promoted', value: String(activeEvents.size) });
        let cursor: string | null = null;
        let scanned = 0;
        let attributedTickets = 0;
        do {
          const page = await repos.orders.listByPromoter(profile.organizationId, {
            limit: 1000,
            cursor,
          });
          for (const order of page.items) {
            if (
              order.status === 'paid' ||
              order.status === 'refund_requested' ||
              order.status === 'refunded'
            ) {
              attributedTickets += order.lines.reduce((sum, line) => sum + line.quantity, 0);
            }
          }
          scanned += page.items.length;
          cursor = page.nextCursor;
          if (scanned >= 10_000 && cursor !== null) break;
        } while (cursor !== null);
        if (cursor === null)
          stats.push({
            label: 'Historically attributed tickets',
            value: String(attributedTickets),
          });
      } else {
        stats.push({
          label: kind === 'venue' ? 'Events at venue' : 'Events hosted',
          value: String(profile.eventCount),
        });
        if (overview)
          stats.push({
            label: 'Guests checked in',
            value: overview.totalCheckIns.toLocaleString('en-IN'),
          });
      }
      const activeConnections =
        partnerships.items.filter((item) => item.status === 'active').length +
        connections.items.filter((item) => item.status === 'active').length;
      stats.push({ label: 'Connections', value: String(activeConnections) });

      const payload = {
        id: profile.id,
        kind: profile.kind,
        name: profile.name,
        slug: profile.slug,
        city: profile.city,
        verified: false,
        bio: profile.bio,
        photoUrl: profile.photoUrl,
        coverUrl: profile.coverUrl,
        genres: profile.genres,
        stats,
        upcomingEvents: upcoming,
        venue: profile.venue,
      };
      const validated = validateV2Response(reply, request, partnerPublicProfileDtoSchema, payload);
      if (!validated) return reply;
      return reply.send(validated);
    },
  );
}
