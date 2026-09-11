import {
  adminEventListResponseSchema,
  adminHostListResponseSchema,
  adminUserListResponseSchema,
  adminVenueListResponseSchema,
  paginationQuerySchema,
} from '@c1rcle/contracts/client';

import type { Event, Organization, PlatformUser, Venue } from '@c1rcle/core/domain';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';

/**
 * ─── Admin directory (Phase 7 admin) ─────────────────────────────────────────
 *
 * Platform-wide, read-mostly registration views. Every handler begins with
 * `services.adminOps.<x>`, which runs `AdminAuthorityService.requireAdmin`
 * internally — no `requirePermission` needed, same as every other admin
 * route in this repo. Responses use the frozen `paginatedSchema` envelope
 * (`{ items, pageInfo }`), summary DTOs only.
 *
 * `GET /admin/audit/export.csv` returns the admin audit trail as `text/csv` —
 * the one deliberately non-`{ok}` route: it is a download, not a contract
 * resource, and it records its own `ADMIN_EXPORT` audit row.
 */

const services = createV2Services();

const directoryQuerySchema = paginationQuerySchema;

function listResponse<T>(items: T[], total: number, limit: number, nextCursor: string | null) {
  return {
    items,
    pageInfo: {
      page: 1,
      pageSize: limit,
      total,
      hasNextPage: nextCursor !== null,
    },
  };
}

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

function eventToDto(event: Event) {
  return {
    id: event.id,
    organizationId: event.organizationId,
    venueId: event.venueId,
    slug: event.slug,
    title: event.title,
    status: event.status,
    isPublic: event.isPublic,
    startAt: event.startAt,
    endAt: event.endAt,
    startingPricePaise: event.startingPricePaise,
    isFree: event.isFree,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

function hostToDto(org: Organization) {
  return {
    id: org.id,
    ownerId: org.ownerId,
    name: org.name,
    slug: org.slug,
    status: org.status,
    platformFeePercent: org.platformFeePercent,
    memberCount: org.members.length,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  };
}

function userToDto(user: PlatformUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    emailVerified: user.emailVerified,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

export default async function adminDirectoryRoutes(fastify: FastifyInstance) {
  /* ─── Reads ──────────────────────────────────────────────────────────────── */

  fastify.get(
    '/admin/venues',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: directoryQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof directoryQuerySchema>;

      const page = await services.adminOps
        .listVenues(userId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        adminVenueListResponseSchema,
        listResponse(page.items.map(venueToDto), page.total, query.limit, page.nextCursor),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/admin/events',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: directoryQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof directoryQuerySchema>;

      const page = await services.adminOps
        .listEvents(userId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        adminEventListResponseSchema,
        listResponse(page.items.map(eventToDto), page.total, query.limit, page.nextCursor),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/admin/hosts',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: directoryQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof directoryQuerySchema>;

      const page = await services.adminOps
        .listHosts(userId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        adminHostListResponseSchema,
        listResponse(page.items.map(hostToDto), page.total, query.limit, page.nextCursor),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/admin/users',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: directoryQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof directoryQuerySchema>;

      const page = await services.adminOps
        .listUsers(userId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        adminUserListResponseSchema,
        listResponse(page.items.map(userToDto), page.total, query.limit, page.nextCursor),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/admin/audit/export.csv',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({})],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;

      const rows = await services.adminOps
        .exportAudit(userId, 1000)
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (rows === undefined) return reply;

      const header = [
        'adminId',
        'adminRole',
        'action',
        'targetType',
        'targetId',
        'reason',
        'occurredAt',
      ];
      const lines = rows.map((row) =>
        [
          csvEscape(row.adminId),
          csvEscape(row.adminRole),
          csvEscape(row.action),
          csvEscape(row.targetType),
          csvEscape(row.targetId),
          csvEscape(row.reason ?? null),
          csvEscape(new Date(row.occurredAt ?? Date.now()).toISOString()),
        ].join(','),
      );
      const csv = [header.map(csvEscape).join(','), ...lines].join('\n');
      return reply
        .type('text/csv')
        .header('Content-Disposition', 'attachment; filename="admin-audit.csv"')
        .send(csv);
    },
  );
}

export { csvEscape };
