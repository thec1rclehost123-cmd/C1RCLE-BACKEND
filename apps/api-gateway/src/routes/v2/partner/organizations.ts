import {
  opaqueIdSchema,
  idempotencyKeySchema,
  paginationQuerySchema,
  organizationDtoSchema,
  organizationMemberDtoSchema,
  inviteMemberSchema,
  invitationDtoSchema,
  createInvitationSchema,
  partnerAccessDtoSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { effectiveInvitationStatus, partnerAccessContext } from '@c1rcle/core/domain';
import { z } from 'zod';

import type {
  Capability,
  Organization,
  OrganizationInvitation,
  OrganizationRole,
} from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 partners organizations slice ─────────────────────────────────────────
 * Thin routes (T16): validate → actor → `OrganizationService` → serialize to
 * the canonical `organizationDtoSchema`. Route is org-scoped server-side via
 * the service (never trusts client ids for authz).
 */

const services = createV2Services();

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

const orgHeaders = z.looseObject({
  'x-organization-id': opaqueIdSchema,
  'idempotency-key': idempotencyKeySchema.optional(),
});

const orgListSchema = paginatedSchema(organizationDtoSchema);
const memberListSchema = paginatedSchema(organizationMemberDtoSchema);
const invitationListSchema = paginatedSchema(invitationDtoSchema);
const invitationIdParam = z.object({ invitationId: opaqueIdSchema });

export default async function partnerOrganizationRoutes(fastify: FastifyInstance) {
  // ── LIST (active memberships only) ────────────────────────────────────────
  fastify.get(
    '/organizations',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: paginationQuerySchema, headers: orgHeaders }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.organizations.list(actor, {
        limit: query.limit,
        cursor: query.cursor ?? null,
      });
      const items = page.items.map((org) => organizationToDto(org, actor.userId));
      const payload = {
        items,
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
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
        fastify.validateV2({ params: organizationIdParam, headers: orgHeaders }),
        fastify.requirePermission('organization.read'),
        fastify.cached('ORGANIZATION'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const actor = services.actor(request);
      const org = await services.organizations
        .get(actor, organizationId)
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

  // ── CREATE (idempotent: manifest organizations.create REQUIRED) ────────────
  fastify.post(
    '/organizations',
    {
      // No `requirePermission` here on purpose: creating your first
      // organization happens before any membership exists to grant a role.
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          body: createOrganizationBody,
          headers: orgHeaders.extend({ 'idempotency-key': idempotencyKeySchema }),
        }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createOrganizationBody>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'organizations.create',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: {}, body },
        run: async () => {
          const org = await services.organizations.create(actor, {
            name: body.name,
            slug: body.slug,
            settings: body.settings,
          });
          const validated = validateV2Response(
            reply,
            request,
            organizationDtoSchema,
            organizationToDto(org, actor.userId),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, 'new_org', error, {
            conflictId: v2Headers['idempotency-key'],
          });
        }
        return mapDomainError(reply, request, 'new_org', error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── UPDATE (PATCH, optimistic-locked + idempotent) ─────────────────────────
  fastify.patch(
    '/organizations/:organizationId',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: organizationIdParam,
          headers: orgHeaders.extend({
            'idempotency-key': idempotencyKeySchema,
            'if-match': z
              .string()
              .regex(/^[1-9][0-9]*$/, 'If-Match must be a positive integer version'),
          }),
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
        fastify.requirePermission('organization.update'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const body = request.body as {
        name?: string;
        slug?: string;
        settings?: { name?: string; timezone?: string };
      };
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const expectedVersion = v2Headers['if-match']
        ? Number.parseInt(v2Headers['if-match'], 10)
        : null;
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'organizations.update',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { organizationId }, body },
        run: async () => {
          const org = await services.organizations.update(actor, {
            actor,
            organizationId,
            expectedVersion,
            props: body,
          });
          const validated = validateV2Response(
            reply,
            request,
            organizationDtoSchema,
            organizationToDto(org, actor.userId),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, organizationId, error, {
            conflictId: v2Headers['idempotency-key'],
          });
        }
        return mapDomainError(reply, request, organizationId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── MEMBERS (task.md §5) ──────────────────────────────────────────────────
  fastify.get(
    '/organizations/:organizationId/members',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: organizationIdParam,
          querystring: paginationQuerySchema,
          headers: orgHeaders,
        }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.organizations
        .listMembers(actor, organizationId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) =>
          mapDomainError(reply, request, organizationId, error, { hideForbidden: true }),
        );
      if (page === undefined) return reply;
      const payload = {
        items: page.items,
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, memberListSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/organizations/:organizationId/members',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: organizationIdParam,
          body: inviteMemberSchema,
          headers: orgHeaders.extend({ 'idempotency-key': idempotencyKeySchema }),
        }),
        fastify.requirePermission('staff.manage'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const body = request.body as z.infer<typeof inviteMemberSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'organizations.inviteMember',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { organizationId }, body },
        run: async () => {
          const org = await services.organizations.inviteMember(actor, {
            organizationId,
            userId: body.userId,
            role: body.role,
            capabilities: body.capabilities,
          });
          const member = org.members.find((m) => m.userId === body.userId);
          const validated = validateV2Response(reply, request, organizationMemberDtoSchema, member);
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, organizationId, error, {
            conflictId: v2Headers['idempotency-key'],
          });
        }
        return mapDomainError(reply, request, organizationId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
  // ── ACCESS CONTEXT (what this member may see and do) ──────────────────────
  // v1's rbac-permissions.ts opens with "the frontend must NEVER define or
  // evaluate these" — this is the endpoint that makes that possible. Hiding a
  // tab is a convenience; every request is still authorized server-side.
  fastify.get(
    '/organizations/:organizationId/access',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: organizationIdParam, headers: orgHeaders }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const actor = services.actor(request);
      const org = await services.organizations
        .get(actor, organizationId)
        .catch((error: unknown) =>
          mapDomainError(reply, request, organizationId, error, { hideForbidden: true }),
        );
      if (org === undefined) return reply;

      const membership = org.members.find((member) => member.userId === actor.userId);
      // Capability decides WHICH matrix applies: the same person can be a
      // venue manager and a host owner, and those are different dashboards.
      const partnerType = primaryPartnerType(membership?.capabilities ?? []);
      const context = partnerAccessContext(partnerType, toPartnerRole(membership?.role));

      const payload = {
        organizationId,
        userId: actor.userId,
        partnerType: context.partnerType,
        role: context.role,
        permissions: [...context.permissions],
        tabVisibility: context.tabVisibility,
      };
      const validated = validateV2Response(reply, request, partnerAccessDtoSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── INVITATIONS ───────────────────────────────────────────────────────────
  // A pending invitation is a real domain concept now (see
  // `domain/models/organization.ts`), so this route reports real state rather
  // than the always-empty list that rule 10 forbade in Phase 0.
  fastify.get(
    '/organizations/:organizationId/invitations',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: organizationIdParam,
          querystring: paginationQuerySchema,
          headers: orgHeaders,
        }),
        fastify.requirePermission('staff.manage'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.organizations
        .listInvitations(actor, organizationId, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        })
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (page === undefined) return reply;

      const payload = {
        items: page.items.map(invitationToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, invitationListSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/organizations/:organizationId/invitations',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: organizationIdParam,
          headers: orgHeaders.extend({ 'idempotency-key': idempotencyKeySchema }),
          body: createInvitationSchema,
        }),
        fastify.requirePermission('staff.manage'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const body = request.body as z.infer<typeof createInvitationSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'organization-invitations.create',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { organizationId }, body },
        run: async () => {
          const invitation = await services.organizations.createInvitation(actor, {
            organizationId,
            email: body.email,
            role: body.role,
            capabilities: body.capabilities,
          });
          const validated = validateV2Response(
            reply,
            request,
            invitationDtoSchema,
            invitationToDto(invitation),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) => {
        if (isIdempotencyConflict(error)) {
          return mapDomainError(reply, request, organizationId, error, {
            conflictId: v2Headers['idempotency-key'],
          });
        }
        return mapDomainError(reply, request, organizationId, error);
      });
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // Revoking is how an invitation is withdrawn; there is no DELETE because the
  // row survives as the audit trail of what was offered and taken back.
  fastify.post(
    '/invitations/:invitationId/revoke',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: invitationIdParam,
          headers: orgHeaders.extend({ 'idempotency-key': idempotencyKeySchema }),
        }),
        fastify.requirePermission('staff.manage'),
      ],
    },
    async (request, reply) => {
      const { invitationId } = request.params as z.infer<typeof invitationIdParam>;
      const actor = services.actor(request);
      const invitation = await services.organizations
        .revokeInvitation(actor, invitationId)
        .catch((error: unknown) => mapDomainError(reply, request, invitationId, error));
      if (invitation === undefined) return reply;

      const validated = validateV2Response(
        reply,
        request,
        invitationDtoSchema,
        invitationToDto(invitation),
      );
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // Accepting is the invitee's own act: it needs a session but NOT membership
  // of the target org (that is exactly what is being granted), so it carries no
  // `requirePermission` and no `X-Organization-Id`.
  fastify.post(
    '/invitations/:invitationId/accept',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: invitationIdParam }),
      ],
    },
    async (request, reply) => {
      const { invitationId } = request.params as z.infer<typeof invitationIdParam>;
      const actor = services.actor(request);
      const org = await services.organizations
        .acceptInvitation(actor, { invitationId, userId: actor.userId })
        .catch((error: unknown) => mapDomainError(reply, request, invitationId, error));
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
}

/** Wire shape for an invitation. `acceptedBy` stays internal — the audit
 * trail does not need to be a public field on the partner surface. */
function invitationToDto(invitation: OrganizationInvitation) {
  return {
    id: invitation.id,
    organizationId: invitation.organizationId,
    email: invitation.email,
    role: invitation.role,
    capabilities: [...invitation.capabilities],
    // Report the EFFECTIVE status: a lapsed invitation reads as `expired`
    // even if no sweeper has rewritten the stored row.
    status: effectiveInvitationStatus(invitation),
    invitedBy: invitation.invitedBy,
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
    version: invitation.version,
    createdAt: invitation.createdAt,
    updatedAt: invitation.updatedAt,
  };
}

/**
 * Which matrix applies. An organization can hold several capabilities; venue
 * duty is the most operationally restrictive, so it wins when present — a
 * member should not gain door-side reach through a broader capability.
 */
function primaryPartnerType(capabilities: readonly Capability[]): string {
  if (capabilities.includes('venue')) return 'venue';
  if (capabilities.includes('host')) return 'host';
  if (capabilities.includes('promoter')) return 'promoter';
  return 'venue';
}

/**
 * Bridges V2's tenancy role to v1's operational role vocabulary. `admin` maps
 * to MANAGER rather than OWNER: an org admin runs the tenant, but "owner" in
 * the partner matrix carries payout and settings authority that should be
 * granted deliberately, not inherited.
 */
function toPartnerRole(role: OrganizationRole | undefined): string {
  switch (role) {
    case 'owner':
      return 'OWNER';
    case 'admin':
    case 'manager':
      return 'MANAGER';
    case 'member':
    case undefined:
      return 'STAFF';
  }
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
