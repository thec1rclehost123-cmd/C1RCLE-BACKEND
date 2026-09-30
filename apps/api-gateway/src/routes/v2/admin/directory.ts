import {
  adminEventListResponseSchema,
  adminHostListResponseSchema,
  adminLookupResponseSchema,
  adminUserListResponseSchema,
  adminVenueListResponseSchema,
  paginationQuerySchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Event, Organization, PlatformUser, Venue } from '@c1rcle/core/domain';

import { csvEscape } from '../../../lib/csv.js';
import { requestMeta } from '../../../lib/v2-request-meta.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

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
const lookupQuerySchema = z.object({ q: z.string().min(1).max(200) });

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
    adminOverride: event.adminOverride,
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

function userToDto(user: PlatformUser & { isBanned: boolean }) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    emailVerified: user.emailVerified,
    role: user.role,
    isBanned: user.isBanned,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
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
    '/admin/lookup',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: lookupQuerySchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const query = request.query as z.infer<typeof lookupQuerySchema>;

      const items = await services.adminOps
        .globalLookup(userId, query.q)
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (items === undefined) return reply;

      const validated = validateV2Response(reply, request, adminLookupResponseSchema, { items });
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  /**
   * Venues/events/hosts CSV exports — same desk data as their `GET
   * /admin/*` list routes, capped at 1000 rows. Unlike users/audit these
   * carry no PII redaction concern and aren't independently audited (the
   * underlying `listX` call is already covered by ordinary read access).
   */
  fastify.get(
    '/admin/venues/export.csv',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({})],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;

      const page = await services.adminOps
        .listVenues(userId, { limit: 1000, cursor: null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const header = [
        'id',
        'organizationId',
        'name',
        'slug',
        'city',
        'status',
        'capacity',
        'createdAt',
      ];
      const lines = page.items.map((venue) => {
        const dto = venueToDto(venue);
        return [
          csvEscape(dto.id),
          csvEscape(dto.organizationId),
          csvEscape(dto.name),
          csvEscape(dto.slug),
          csvEscape(dto.city),
          csvEscape(dto.status),
          csvEscape(dto.capacity),
          csvEscape(new Date(dto.createdAt).toISOString()),
        ].join(',');
      });
      const csv = [header.map(csvEscape).join(','), ...lines].join('\n');
      return reply
        .type('text/csv')
        .header('Content-Disposition', 'attachment; filename="venues.csv"')
        .send(csv);
    },
  );

  fastify.get(
    '/admin/events/export.csv',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({})],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;

      const page = await services.adminOps
        .listEvents(userId, { limit: 1000, cursor: null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const header = [
        'id',
        'organizationId',
        'venueId',
        'slug',
        'title',
        'status',
        'isPublic',
        'startAt',
        'endAt',
        'startingPricePaise',
        'isFree',
        'createdAt',
      ];
      const lines = page.items.map((event) => {
        const dto = eventToDto(event);
        return [
          csvEscape(dto.id),
          csvEscape(dto.organizationId),
          csvEscape(dto.venueId),
          csvEscape(dto.slug),
          csvEscape(dto.title),
          csvEscape(dto.status),
          csvEscape(dto.isPublic ? 'true' : 'false'),
          csvEscape(dto.startAt),
          csvEscape(dto.endAt),
          csvEscape(dto.startingPricePaise),
          csvEscape(dto.isFree ? 'true' : 'false'),
          csvEscape(new Date(dto.createdAt).toISOString()),
        ].join(',');
      });
      const csv = [header.map(csvEscape).join(','), ...lines].join('\n');
      return reply
        .type('text/csv')
        .header('Content-Disposition', 'attachment; filename="events.csv"')
        .send(csv);
    },
  );

  fastify.get(
    '/admin/hosts/export.csv',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({})],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;

      const page = await services.adminOps
        .listHosts(userId, { limit: 1000, cursor: null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (page === undefined) return reply;

      const header = [
        'id',
        'ownerId',
        'name',
        'slug',
        'status',
        'platformFeePercent',
        'memberCount',
        'createdAt',
      ];
      const lines = page.items.map((org) => {
        const dto = hostToDto(org);
        return [
          csvEscape(dto.id),
          csvEscape(dto.ownerId),
          csvEscape(dto.name),
          csvEscape(dto.slug),
          csvEscape(dto.status),
          csvEscape(dto.platformFeePercent),
          csvEscape(dto.memberCount),
          csvEscape(new Date(dto.createdAt).toISOString()),
        ].join(',');
      });
      const csv = [header.map(csvEscape).join(','), ...lines].join('\n');
      return reply
        .type('text/csv')
        .header('Content-Disposition', 'attachment; filename="hosts.csv"')
        .send(csv);
    },
  );

  /**
   * User directory CSV export, PII-redacted — ported from v1's
   * `exports/route.js`. Only `super`/`finance` see a real email; every
   * other role gets it redacted. Audited with the row count.
   */
  fastify.get(
    '/admin/users/export.csv',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({})],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;

      const result = await services.adminOps
        .exportUsers(userId, requestMeta(request))
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (result === undefined) return reply;

      const header = ['id', 'name', 'email', 'role', 'emailVerified', 'isBanned', 'createdAt'];
      const lines = result.rows.map((row) =>
        [
          csvEscape(row.id),
          csvEscape(row.name),
          csvEscape(result.redactEmail ? '[redacted]' : row.email),
          csvEscape(row.role),
          csvEscape(row.emailVerified ? 'true' : 'false'),
          csvEscape(row.isBanned ? 'true' : 'false'),
          csvEscape(new Date(row.createdAt).toISOString()),
        ].join(','),
      );
      const csv = [header.join(','), ...lines].join('\n');

      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="users.csv"')
        .send(csv);
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
        .exportAudit(userId, 1000, requestMeta(request))
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (rows === undefined) return reply;

      const names = await services.adminOps.resolveTargetNames(userId, rows);
      const header = [
        'adminId',
        'adminRole',
        'action',
        'targetType',
        'targetId',
        'targetName',
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
          csvEscape(names.get(`${row.targetType ?? ''}:${row.targetId ?? ''}`) ?? null),
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
