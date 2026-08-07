import {
  opaqueIdSchema,
  idempotencyKeySchema,
  paginationQuerySchema,
  organizationDtoSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Organization, OrganizationRole } from '@c1rcle/core/domain';

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

export default async function partnerOrganizationRoutes(fastify: FastifyInstance) {
  // ── LIST (active memberships only) ────────────────────────────────────────
  fastify.get(
    '/organizations',
    {
      preHandler: fastify.validateV2({ querystring: paginationQuerySchema, headers: orgHeaders }),
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
      preHandler: fastify.validateV2({ params: organizationIdParam, headers: orgHeaders }),
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

  // ── CREATE ────────────────────────────────────────────────────────────────
  fastify.post(
    '/organizations',
    {
      preHandler: fastify.validateV2({ body: createOrganizationBody, headers: orgHeaders }),
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createOrganizationBody>;
      const actor = services.actor(request);
      const org = await services.organizations
        .create(actor, {
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
      preHandler: fastify.validateV2({
        params: organizationIdParam,
        headers: orgHeaders.extend({ 'if-match': z.string().regex(/^[1-9][0-9]*$/) }),
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
      const org = await services.organizations
        .update(actor, { actor, organizationId, expectedVersion, props: body })
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
