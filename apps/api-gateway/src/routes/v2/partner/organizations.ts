import { buildV2ErrorResponse } from '@c1rcle/contracts';
import {
  opaqueIdSchema,
  idempotencyKeySchema,
  versionHeaderSchema,
  paginationQuerySchema,
  organizationDtoSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Organization, OrganizationMember, OrganizationRole } from '@c1rcle/core/domain';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { getV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 partners organizations slice ─────────────────────────────────────────
 * Thin routes (T16): validate → actor → `OrganizationService` → serialize to
 * the canonical `organizationDtoSchema`. Route is org-scoped server-side via
 * the service (never trusts client ids for authz).
 */

/**
 * Resolved per call, not captured at import time: a module-level binding would
 * freeze the first bundle and leave the auth plugin checking membership against
 * a different store than the routes write to.
 */
const services = () => getV2Services();

const organizationIdParam = z.object({ organizationId: opaqueIdSchema });

const createOrganizationBody = z
  .object({
    name: z.string().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid slug format'),
    settings: z
      .object({ name: z.string().max(200).optional(), timezone: z.string().max(50).optional() })
      .optional(),
  })
  .strict();

/** Read headers: no command safety applies to a GET. */
const orgHeaders = z.looseObject({
  'x-organization-id': opaqueIdSchema,
});

/**
 * Write headers. The manifest marks every partner write `idempotency: REQUIRED`
 * (T09) and every PATCH `expectedVersion: REQUIRED` (T10), so both headers are
 * mandatory here — a missing one is a 422 with `fieldErrors`, not a silent
 * unprotected write. `version` is deliberately absent from write bodies: the
 * `If-Match` header is the only version authority, and a body carrying one is
 * rejected by the strict schema.
 */
const orgCommandHeaders = orgHeaders.extend({
  'idempotency-key': idempotencyKeySchema,
});

/**
 * `organizations.create` is the one write with no tenant to scope to — the
 * tenant is what it creates — so it requires the idempotency key but not
 * `X-Organization-Id`.
 */
const orgCreateHeaders = z.looseObject({
  'idempotency-key': idempotencyKeySchema,
});

const orgUpdateHeaders = orgCommandHeaders.extend({
  'if-match': versionHeaderSchema,
});

const orgListSchema = paginatedSchema(organizationDtoSchema);

const memberDtoSchema = z.object({
  userId: opaqueIdSchema,
  role: z.enum(['owner', 'admin', 'manager', 'member']),
  capabilities: z.array(z.enum(['host', 'venue', 'promoter'])),
  joinedAt: z.iso.datetime(),
});
const memberListSchema = paginatedSchema(memberDtoSchema);

const inviteMemberBody = z
  .object({
    userId: opaqueIdSchema,
    role: z.enum(['admin', 'manager', 'member']),
    capabilities: z.array(z.enum(['host', 'venue', 'promoter'])).optional(),
  })
  .strict();

export default async function partnerOrganizationRoutes(fastify: FastifyInstance) {
  // ── LIST (active memberships only) ────────────────────────────────────────
  fastify.get(
    '/organizations',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.authenticate(),
        fastify.requirePermission('organization.read'),
        fastify.validateV2({ querystring: paginationQuerySchema, headers: orgHeaders }),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services().actor(request);
      const page = await services().organizations.list(actor, {
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
      const items = page.items.map((org) => organizationToDto(org, actor.userId));
      const payload = {
        items,
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: items.length,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, orgListSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── GET ONE ───────────────────────────────────────────────────────────────
  fastify.get(
    '/organizations/:organizationId',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.authenticate(),
        fastify.requirePermission('organization.read'),
        fastify.cached('ORGANIZATION'),
        fastify.validateV2({ params: organizationIdParam, headers: orgHeaders }),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const actor = services().actor(request);
      const org = await services()
        .organizations.get(actor, organizationId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, organizationId, error, { hideForbidden: true }),
        );
      if (org === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        organizationDtoSchema,
        organizationToDto(org, actor.userId),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── CREATE ────────────────────────────────────────────────────────────────
  fastify.post(
    '/organizations',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        // Creating an org needs a session but no prior membership — it is the
        // one command that legitimately has no tenant to belong to yet.
        fastify.authenticate({ requireOrganization: false }),
        fastify.validateV2({ body: createOrganizationBody, headers: orgCreateHeaders }),
        fastify.idempotent('organizations.create'),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createOrganizationBody>;
      // No tenant exists yet — this command creates one.
      const actor = services().actorWithoutTenant(request);
      const org = await services()
        .organizations.create(actor, {
          name: body.name,
          slug: body.slug,
          settings: body.settings,
        })
        .catch((error: unknown) => mapDomainError(reply, request, 'new_org', error));
      if (org === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        organizationDtoSchema,
        organizationToDto(org, actor.userId),
      );
      if (validated === undefined) return reply;
      return reply.status(201).send(validated);
    },
  );

  // ── UPDATE (PATCH, optimistic-locked via If-Match) ────────────────────────
  fastify.patch(
    '/organizations/:organizationId',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.authenticate(),
        fastify.requirePermission('organization.update'),
        fastify.validateV2({
          params: organizationIdParam,
          headers: orgUpdateHeaders,
          body: z
            .object({
              name: z.string().min(1).max(200).optional(),
              slug: z
                .string()
                .min(1)
                .max(60)
                .regex(/^[a-z0-9][a-z0-9-]*$/)
                .optional(),
              settings: z
                .object({
                  name: z.string().max(200).optional(),
                  timezone: z.string().max(50).optional(),
                })
                .optional(),
            })
            .strict(),
        }),
        fastify.idempotent('organizations.update'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const body = request.body as {
        name?: string;
        slug?: string;
        settings?: { name?: string; timezone?: string };
      };
      const actor = services().actor(request);
      const v2Headers = request.v2Headers ?? {};
      const expectedVersion = v2Headers['if-match']
        ? Number.parseInt(v2Headers['if-match'], 10)
        : null;
      const org = await services()
        .organizations.update(actor, { actor, organizationId, expectedVersion, props: body })
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (org === undefined) return reply;
      const validated = validateV2Response(
        reply,
        request,
        organizationDtoSchema,
        organizationToDto(org, actor.userId),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── MEMBERS ───────────────────────────────────────────────────────────────
  fastify.get(
    '/organizations/:organizationId/members',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.authenticate(),
        fastify.requirePermission('organization.read'),
        fastify.validateV2({
          params: organizationIdParam,
          querystring: paginationQuerySchema,
          headers: orgHeaders,
        }),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services().actor(request);
      const page = await services()
        .organizations.listMembers(actor, organizationId, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        })
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (page === undefined) return reply;

      const payload = {
        items: page.items.map(memberToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.items.length,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, memberListSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── INVITE A MEMBER ───────────────────────────────────────────────────────
  fastify.post(
    '/organizations/:organizationId/members',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.authenticate(),
        fastify.requirePermission('staff.manage'),
        fastify.validateV2({
          params: organizationIdParam,
          headers: orgCommandHeaders,
          body: inviteMemberBody,
        }),
        fastify.idempotent('organization-members.invite'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const body = request.body as z.infer<typeof inviteMemberBody>;
      const actor = services().actor(request);
      const org = await services()
        .organizations.inviteMember(actor, {
          organizationId,
          userId: body.userId,
          role: body.role,
          capabilities: body.capabilities,
        })
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (org === undefined) return reply;

      const member = org.members.find((entry) => entry.userId === body.userId);
      if (!member) {
        return reply.status(500).send(
          buildV2ErrorResponse({
            status: 500,
            code: 'server',
            message: 'Internal server error',
            requestId: request.id,
          }),
        );
      }
      const validated = validateV2Response(reply, request, memberDtoSchema, memberToDto(member));
      if (validated === undefined) return reply;
      return reply.status(201).send(validated);
    },
  );
}

/** Membership on the wire. Capabilities are exposed; invite metadata is not. */
function memberToDto(member: OrganizationMember) {
  return {
    userId: member.userId,
    role: member.role,
    capabilities: [...member.capabilities],
    joinedAt: member.joinedAt,
  };
}

/** Converts the core domain Organization to the canonical wire DTO (caller-scoped). */
export function organizationToDto(org: Organization, userId: string) {
  const membership = org.members.find((member) => member.userId === userId);
  const role: OrganizationRole = membership?.role ?? 'member';
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    role,
    status: org.status,
    version: org.version,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  };
}
