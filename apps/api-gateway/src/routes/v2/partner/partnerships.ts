import {
  opaqueIdSchema,
  idempotencyKeySchema,
  paginationQuerySchema,
  partnershipDtoSchema,
  requestPartnershipSchema,
  resolvePartnershipSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Partnership } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 partnerships slice (Phase 1) ─────────────────────────────────────────
 *
 * The venue↔host graph, ported from v1 `routes/v1/partnerships.ts`. Every rule
 * about who may answer a request lives in `domain/models/partnership.ts`; these
 * routes only validate, scope and serialize.
 *
 * Resolution actions are POSTs rather than a PATCH of `status`: "approve" and
 * "block" are different authorities with different rules, and collapsing them
 * into one mutable field is exactly what made v1's `statusMap` able to
 * silently un-block a partnership.
 */

const services = createV2Services();

const organizationIdParam = z.object({ organizationId: opaqueIdSchema });
const partnershipIdParam = z.object({ partnershipId: opaqueIdSchema });

const readHeaders = z.looseObject({ 'x-organization-id': opaqueIdSchema });
const commandHeaders = readHeaders.extend({ 'idempotency-key': idempotencyKeySchema });

const partnershipListSchema = paginatedSchema(partnershipDtoSchema);

export default async function partnerPartnershipRoutes(fastify: FastifyInstance) {
  // ── LIST (either side of the graph) ───────────────────────────────────────
  fastify.get(
    '/organizations/:organizationId/partnerships',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: organizationIdParam,
          querystring: paginationQuerySchema,
          headers: readHeaders,
        }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as z.infer<typeof organizationIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.partnerships
        .listForOrganization(actor, organizationId, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        })
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (page === undefined) return reply;

      const payload = {
        items: page.items.map(partnershipToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, partnershipListSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── REQUEST ───────────────────────────────────────────────────────────────
  fastify.post(
    '/partnerships',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ headers: commandHeaders, body: requestPartnershipSchema }),
        fastify.requirePermission('venue.manage'),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof requestPartnershipSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'partnerships.request',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: {}, body },
        run: async () => {
          const partnership = await services.partnerships.request(actor, {
            venueId: body.venueId,
            initiatedBy: body.initiatedBy,
            message: body.message,
          });
          const validated = validateV2Response(
            reply,
            request,
            partnershipDtoSchema,
            partnershipToDto(partnership),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, body.venueId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, body.venueId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ── RESOLUTION ACTIONS ────────────────────────────────────────────────────
  // `approve`/`reject` are the counterparty's answer; `block` and `end` are
  // open to either side. The domain enforces which is which — the route only
  // says who is asking.
  registerAction(fastify, 'approve', (actor, id) => services.partnerships.approve(actor, id));
  registerAction(fastify, 'reject', (actor, id, reason) =>
    services.partnerships.reject(actor, id, reason),
  );
  registerAction(fastify, 'block', (actor, id, reason) =>
    services.partnerships.block(actor, id, reason),
  );
  registerAction(fastify, 'end', (actor, id) => services.partnerships.end(actor, id));
}

type ActorOf = ReturnType<typeof services.actor>;

/** POST /partnerships/:partnershipId/<action> — one shape for every answer. */
function registerAction(
  fastify: FastifyInstance,
  action: string,
  run: (actor: ActorOf, partnershipId: string, reason?: string) => Promise<Partnership>,
): void {
  fastify.post(
    `/partnerships/:partnershipId/${action}`,
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: partnershipIdParam,
          headers: commandHeaders,
          body: resolvePartnershipSchema.optional(),
        }),
        fastify.requirePermission('venue.manage'),
      ],
    },
    async (request, reply) => {
      const { partnershipId } = request.params as z.infer<typeof partnershipIdParam>;
      const body = (request.body ?? {}) as z.infer<typeof resolvePartnershipSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: `partnerships.${action}`,
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { partnershipId }, body },
        run: async () => {
          const partnership = await run(actor, partnershipId, body.reason);
          const validated = validateV2Response(
            reply,
            request,
            partnershipDtoSchema,
            partnershipToDto(partnership),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, partnershipId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, partnershipId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}

function partnershipToDto(partnership: Partnership) {
  return {
    id: partnership.id,
    hostOrganizationId: partnership.hostOrganizationId,
    venueOrganizationId: partnership.venueOrganizationId,
    venueId: partnership.venueId,
    initiatedBy: partnership.initiatedBy,
    status: partnership.status,
    message: partnership.message,
    resolutionReason: partnership.resolutionReason,
    resolvedAt: partnership.resolvedAt,
    version: partnership.version,
    createdAt: partnership.createdAt,
    updatedAt: partnership.updatedAt,
  };
}
