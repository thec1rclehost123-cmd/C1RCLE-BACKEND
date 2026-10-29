import {
  idempotencyKeySchema,
  opaqueIdSchema,
  paginationQuerySchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

const services = createV2Services();
const eventParams = z.object({ eventId: opaqueIdSchema });
const allocationParams = z.object({ allocationId: opaqueIdSchema });
const claimParams = z.object({ claimId: opaqueIdSchema });
const revokeBody = z.object({ reason: z.string().trim().min(5).max(500) }).strict();
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });
const createBody = z
  .object({
    tierId: opaqueIdSchema,
    category: z.enum(['artist', 'staff', 'sponsor', 'press', 'influencer']),
    reason: z.string().trim().min(5).max(500),
    quota: z.number().int().positive().max(10000),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .strict();
const issueBody = z
  .object({ recipientUserId: opaqueIdSchema, holderName: z.string().trim().min(1).max(120) })
  .strict();
const allocationSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  tierId: opaqueIdSchema,
  category: z.enum(['artist', 'staff', 'sponsor', 'press', 'influencer']),
  reason: z.string(),
  quota: z.number().int().positive(),
  claimedCount: z.number().int().nonnegative(),
  status: z.enum(['active', 'closed']),
  expiresAt: z.iso.datetime().nullable(),
  createdBy: opaqueIdSchema,
  createdAt: z.iso.datetime(),
});
const claimResponseSchema = z.object({
  allocation: allocationSchema,
  claim: z.object({
    id: opaqueIdSchema,
    allocationId: opaqueIdSchema,
    eventId: opaqueIdSchema,
    organizationId: opaqueIdSchema,
    tierId: opaqueIdSchema,
    recipientUserId: opaqueIdSchema,
    holderName: z.string(),
    status: z.enum(['issued', 'revoked']),
    orderId: opaqueIdSchema,
    issuedBy: opaqueIdSchema,
    issuedAt: z.iso.datetime(),
    revokedBy: opaqueIdSchema.nullable(),
    revokedAt: z.iso.datetime().nullable(),
    revocationReason: z.string().nullable(),
    createdAt: z.iso.datetime(),
  }),
  orderId: opaqueIdSchema,
  entitlements: z.array(
    z
      .object({
        id: opaqueIdSchema,
        orderId: opaqueIdSchema,
        eventId: opaqueIdSchema,
        organizationId: opaqueIdSchema,
        tierId: opaqueIdSchema,
        unitKind: z.literal('complimentary'),
        holderName: z.string(),
      })
      .loose(),
  ),
});
const pageSchema = z.object({
  items: z.array(allocationSchema),
  pageInfo: z.object({
    page: z.number(),
    pageSize: z.number(),
    total: z.number(),
    hasNextPage: z.boolean(),
  }),
});

export default async function adminComplimentaryAllocationRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/admin/events/:eventId/complimentary-allocations',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: eventParams, querystring: paginationQuerySchema }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const adminId = requireUserId(request, reply);
      if (!adminId) return reply;
      const { eventId } = request.params as z.infer<typeof eventParams>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const result = await services.complimentaryAllocations
        .listAllocations(adminId, eventId, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        })
        .catch((error: unknown) => mapDomainError(reply, request, adminId, error));
      if (!result) return reply;
      const body = {
        items: result.items,
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: result.total,
          hasNextPage: result.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, pageSchema, body);
      return validated === undefined ? reply : reply.send(validated);
    },
  );

  fastify.post(
    '/admin/events/:eventId/complimentary-allocations',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: eventParams, headers: commandHeaders, body: createBody }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const adminId = requireUserId(request, reply);
      if (!adminId) return reply;
      const { eventId } = request.params as z.infer<typeof eventParams>;
      const body = request.body as z.infer<typeof createBody>;
      const key = request.v2Headers?.['idempotency-key'];
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: adminId,
        commandName: 'admin.complimentary-allocation.create',
        idempotencyKey: key,
        context: { path: { eventId }, body },
        run: async () => {
          const allocation = await services.complimentaryAllocations.createAllocation(adminId, {
            ...body,
            eventId,
          });
          const validated = validateV2Response(reply, request, allocationSchema, allocation);
          if (!validated) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, eventId, error, { conflictId: key })
          : mapDomainError(reply, request, eventId, error),
      );
      return result ? reply.status(result.statusCode).send(result.body) : reply;
    },
  );

  fastify.post(
    '/admin/complimentary-allocations/:allocationId/claims',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: allocationParams, headers: commandHeaders, body: issueBody }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const adminId = requireUserId(request, reply);
      if (!adminId) return reply;
      const { allocationId } = request.params as z.infer<typeof allocationParams>;
      const body = request.body as z.infer<typeof issueBody>;
      const key = request.v2Headers?.['idempotency-key'];
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: adminId,
        commandName: 'admin.complimentary-allocation.issue',
        idempotencyKey: key,
        context: { path: { allocationId }, body },
        run: async () => {
          const issued = await services.complimentaryAllocations.issueClaim(adminId, allocationId, {
            ...body,
            idempotencyKey: key ?? '',
          });
          const response = {
            allocation: issued.allocation,
            claim: issued.claim,
            orderId: issued.order.id,
            entitlements: issued.entitlements,
          };
          const validated = validateV2Response(reply, request, claimResponseSchema, response);
          if (!validated) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, allocationId, error, { conflictId: key })
          : mapDomainError(reply, request, allocationId, error),
      );
      return result ? reply.status(result.statusCode).send(result.body) : reply;
    },
  );

  fastify.post(
    '/admin/complimentary-claims/:claimId/revoke',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: claimParams, headers: commandHeaders, body: revokeBody }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const adminId = requireUserId(request, reply);
      if (!adminId) return reply;
      const { claimId } = request.params as z.infer<typeof claimParams>;
      const body = request.body as z.infer<typeof revokeBody>;
      const key = request.v2Headers?.['idempotency-key'];
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: adminId,
        commandName: 'admin.complimentary-claim.revoke',
        idempotencyKey: key,
        context: { path: { claimId }, body },
        run: async () => {
          const revoked = await services.complimentaryAllocations.revokeClaim(
            adminId,
            claimId,
            body.reason,
          );
          const response = {
            claimId: revoked.claim.id,
            claimStatus: revoked.claim.status,
            entitlementId: revoked.entitlement?.id,
            entitlementStatus: revoked.entitlement?.status,
          };
          const schema = z.object({
            claimId: opaqueIdSchema,
            claimStatus: z.literal('revoked'),
            entitlementId: opaqueIdSchema,
            entitlementStatus: z.literal('void'),
          });
          const validated = validateV2Response(reply, request, schema, response);
          if (!validated) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, claimId, error, { conflictId: key })
          : mapDomainError(reply, request, claimId, error),
      );
      return result ? reply.status(result.statusCode).send(result.body) : reply;
    },
  );
}
