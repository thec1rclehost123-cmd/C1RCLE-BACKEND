import {
  opaqueIdSchema,
  idempotencyKeySchema,
  paginationQuerySchema,
  promoterConnectionDtoSchema,
  requestConnectionSchema,
  resolvePartnershipSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { PromoterConnection } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Promoter connections (Phase 1) ──────────────────────────────────────────
 *
 * The promoter↔host/venue graph. Kept separate from `/partnerships` (the
 * venue↔host graph) because the parties and the allowed actions differ —
 * notably `revoke`, which only the promoter may do.
 */

const services = createV2Services();

const organizationIdParam = z.object({ organizationId: opaqueIdSchema });
const connectionIdParam = z.object({ connectionId: opaqueIdSchema });

const readHeaders = z.looseObject({ 'x-organization-id': opaqueIdSchema });
const commandHeaders = readHeaders.extend({ 'idempotency-key': idempotencyKeySchema });

const connectionListSchema = paginatedSchema(promoterConnectionDtoSchema);

export default async function promoterConnectionRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/organizations/:organizationId/promoter-connections',
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
      const page = await services.promoterConnections
        .listForOrganization(actor, organizationId, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        })
        .catch((error: unknown) => mapDomainError(reply, request, organizationId, error));
      if (page === undefined) return reply;

      const payload = {
        items: page.items.map(connectionToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, connectionListSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/promoter-connections',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ headers: commandHeaders, body: requestConnectionSchema }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof requestConnectionSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'promoter-connections.request',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: {}, body },
        run: async () => {
          const connection = await services.promoterConnections.request(actor, {
            counterpartyId: body.counterpartyId,
            targetType: body.targetType,
            initiatedBy: body.initiatedBy,
            message: body.message,
          });
          const validated = validateV2Response(
            reply,
            request,
            promoterConnectionDtoSchema,
            connectionToDto(connection),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, body.counterpartyId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, body.counterpartyId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // approve/reject are the recipient's; revoke is the promoter's alone. The
  // domain enforces which is which — the route only reports who is asking.
  registerAction(fastify, 'approve', (actor, id) =>
    services.promoterConnections.approve(actor, id),
  );
  registerAction(fastify, 'reject', (actor, id, reason) =>
    services.promoterConnections.reject(actor, id, reason),
  );
  registerAction(fastify, 'block', (actor, id, reason) =>
    services.promoterConnections.block(actor, id, reason),
  );
  registerAction(fastify, 'revoke', (actor, id) => services.promoterConnections.revoke(actor, id));
}

type ActorOf = ReturnType<typeof services.actor>;

function registerAction(
  fastify: FastifyInstance,
  action: string,
  run: (actor: ActorOf, connectionId: string, reason?: string) => Promise<PromoterConnection>,
): void {
  fastify.post(
    `/promoter-connections/:connectionId/${action}`,
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: connectionIdParam,
          headers: commandHeaders,
          body: resolvePartnershipSchema.optional(),
        }),
        fastify.requirePermission('organization.read'),
      ],
    },
    async (request, reply) => {
      const { connectionId } = request.params as z.infer<typeof connectionIdParam>;
      const body = (request.body ?? {}) as z.infer<typeof resolvePartnershipSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: `promoter-connections.${action}`,
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { connectionId }, body },
        run: async () => {
          const connection = await run(actor, connectionId, body.reason);
          const validated = validateV2Response(
            reply,
            request,
            promoterConnectionDtoSchema,
            connectionToDto(connection),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, connectionId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, connectionId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}

function connectionToDto(connection: PromoterConnection) {
  return {
    id: connection.id,
    promoterId: connection.promoterId,
    targetId: connection.targetId,
    targetType: connection.targetType,
    initiatedBy: connection.initiatedBy,
    status: connection.status,
    message: connection.message,
    resolutionReason: connection.resolutionReason,
    resolvedAt: connection.resolvedAt,
    version: connection.version,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}
