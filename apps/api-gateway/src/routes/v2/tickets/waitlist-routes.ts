import {
  checkoutQuoteResponseSchema,
  idempotencyKeySchema,
  opaqueIdSchema,
  paginationQuerySchema,
  waitlistEntryDtoSchema,
  waitlistQueueResponseSchema,
  waitlistOfferResponseSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

const services = createV2Services();
const joinBody = z
  .object({
    eventId: opaqueIdSchema,
    tierId: opaqueIdSchema,
    accessGrantId: opaqueIdSchema.optional(),
    eligibilityAttested: z.boolean().optional(),
  })
  .strict();
const entryParams = z.object({ entryId: opaqueIdSchema });
const offerParams = z.object({ eventId: opaqueIdSchema, tierId: opaqueIdSchema });
const partnerReadHeaders = z.looseObject({ 'x-organization-id': opaqueIdSchema });
const partnerOfferHeaders = z.looseObject({
  'x-organization-id': opaqueIdSchema,
  'idempotency-key': idempotencyKeySchema,
});
const adminQueueQuery = paginationQuerySchema;
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });
const optionalCommandHeaders = z.looseObject({
  'idempotency-key': idempotencyKeySchema.optional(),
});
const entrySchema = waitlistEntryDtoSchema;
const entryPageSchema = z.object({
  items: z.array(entrySchema),
  pageInfo: z.object({
    page: z.number(),
    pageSize: z.number(),
    total: z.number(),
    hasNextPage: z.boolean(),
  }),
});
const adminQueueResponseSchema = waitlistQueueResponseSchema;
const acceptedSchema = z.object({
  entry: entrySchema,
  holdId: opaqueIdSchema,
  expiresAt: z.iso.datetime(),
  pricing: checkoutQuoteResponseSchema,
});
const offerSchema = waitlistOfferResponseSchema;

function entryDto(entry: {
  id: string;
  eventId: string;
  organizationId: string;
  tierId: string;
  sequence: number;
  status: 'waiting' | 'offered' | 'accepted' | 'expired' | 'cancelled';
  offeredAt: string | null;
  offerExpiresAt: string | null;
  resolvedAt: string | null;
}) {
  return {
    id: entry.id,
    eventId: entry.eventId,
    organizationId: entry.organizationId,
    tierId: entry.tierId,
    sequence: entry.sequence,
    status: entry.status,
    offeredAt: entry.offeredAt,
    offerExpiresAt: entry.offerExpiresAt,
    resolvedAt: entry.resolvedAt,
  };
}

export default async function waitlistRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/waitlist',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: joinBody, headers: optionalCommandHeaders }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const userId = requireUserId(request, reply);
      if (!userId) return reply;
      const body = request.body as z.infer<typeof joinBody>;
      const result = await services.waitlist
        .join({ userId, ...body })
        .catch((error: unknown) => mapDomainError(reply, request, body.eventId, error));
      if (!result) return reply;
      const validated = validateV2Response(reply, request, entrySchema, entryDto(result.entry));
      return validated === undefined
        ? reply
        : reply.status(result.created ? 201 : 200).send(validated);
    },
  );

  fastify.get(
    '/waitlist/:entryId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: entryParams })],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const userId = requireUserId(request, reply);
      if (!userId) return reply;
      const { entryId } = request.params as z.infer<typeof entryParams>;
      const offer = await services.waitlist
        .getAcceptedOffer(userId, entryId)
        .catch((error: unknown) => mapDomainError(reply, request, entryId, error));
      if (!offer) return reply;
      const body = {
        entry: entryDto(offer.entry),
        holdId: offer.holdId,
        expiresAt: offer.expiresAt,
        pricing: offer.pricing,
      };
      const validated = validateV2Response(reply, request, acceptedSchema, body);
      return validated === undefined ? reply : reply.send(validated);
    },
  );

  fastify.get(
    '/waitlist',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: paginationQuerySchema }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const userId = requireUserId(request, reply);
      if (!userId) return reply;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const page = await services.waitlist
        .listMine(userId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (!page) return reply;
      const body = {
        items: page.items.map(entryDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, entryPageSchema, body);
      return validated === undefined ? reply : reply.send(validated);
    },
  );

  fastify.post(
    '/waitlist/:entryId/accept',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: entryParams, headers: optionalCommandHeaders }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const userId = requireUserId(request, reply);
      if (!userId) return reply;
      const { entryId } = request.params as z.infer<typeof entryParams>;
      const key = request.v2Headers?.['idempotency-key'];
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'waitlist.offer.accept',
        idempotencyKey: key,
        context: { path: { entryId }, body: {} },
        run: async () => {
          const accepted = await services.waitlist.accept(userId, entryId);
          const body = {
            entry: entryDto(accepted.entry),
            holdId: accepted.holdId,
            expiresAt: accepted.expiresAt,
            pricing: accepted.pricing,
          };
          const validated = validateV2Response(reply, request, acceptedSchema, body);
          if (!validated) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, entryId, error, { conflictId: key })
          : mapDomainError(reply, request, entryId, error),
      );
      return result ? reply.status(result.statusCode).send(result.body) : reply;
    },
  );

  fastify.delete(
    '/waitlist/:entryId',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: entryParams, headers: optionalCommandHeaders }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const userId = requireUserId(request, reply);
      if (!userId) return reply;
      const { entryId } = request.params as z.infer<typeof entryParams>;
      const result = await services.waitlist
        .cancel(userId, entryId)
        .catch((error: unknown) => mapDomainError(reply, request, entryId, error));
      if (!result) return reply;
      const validated = validateV2Response(reply, request, entrySchema, entryDto(result));
      return validated === undefined ? reply : reply.send(validated);
    },
  );

  fastify.post(
    '/events/:eventId/tiers/:tierId/waitlist/offer-next',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: offerParams, headers: partnerOfferHeaders }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const actor = services.actor(request);
      const { eventId, tierId } = request.params as z.infer<typeof offerParams>;
      const key = request.v2Headers?.['idempotency-key'];
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'partner.waitlist.offer-next',
        idempotencyKey: key,
        context: { path: { eventId, tierId }, body: {} },
        run: async () => {
          const offer = await services.waitlist.offerNextForPartner(actor, eventId, tierId);
          if (!offer) return { statusCode: 200, body: { offered: false } };
          const body = {
            entry: entryDto(offer.entry),
            holdId: offer.holdId,
            expiresAt: offer.expiresAt,
            pricing: offer.pricing,
          };
          const validated = validateV2Response(reply, request, offerSchema, body);
          if (!validated) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, eventId, error, { conflictId: key, hideForbidden: true })
          : mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
      );
      if (!result) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.get(
    '/events/:eventId/tiers/:tierId/waitlist',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: offerParams,
          querystring: adminQueueQuery,
          headers: partnerReadHeaders,
        }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const actor = services.actor(request);
      const { eventId, tierId } = request.params as z.infer<typeof offerParams>;
      const query = request.query as z.infer<typeof adminQueueQuery>;
      const page = await services.waitlist
        .listForPartner(actor, eventId, tierId, {
          limit: query.limit,
          cursor: query.cursor ?? null,
        })
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (!page) return reply;
      const body = {
        items: page.items.map(entryDto),
        pageInfo: {
          page: query.cursor ? Math.floor(Number.parseInt(query.cursor, 10) / query.limit) + 1 : 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
          nextCursor: page.nextCursor,
        },
      };
      const validated = validateV2Response(reply, request, adminQueueResponseSchema, body);
      return validated === undefined ? reply : reply.send(validated);
    },
  );

  fastify.post(
    '/admin/events/:eventId/tiers/:tierId/waitlist/offer-next',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: offerParams, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const adminId = requireUserId(request, reply);
      if (!adminId) return reply;
      const { eventId, tierId } = request.params as z.infer<typeof offerParams>;
      const key = request.v2Headers?.['idempotency-key'];
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: adminId,
        commandName: 'admin.waitlist.offer-next',
        idempotencyKey: key,
        context: { path: { eventId, tierId }, body: {} },
        run: async () => {
          const offer = await services.waitlist.offerNext(adminId, eventId, tierId);
          if (!offer) return { statusCode: 200, body: { offered: false } };
          const body = {
            entry: entryDto(offer.entry),
            holdId: offer.holdId,
            expiresAt: offer.expiresAt,
            pricing: offer.pricing,
          };
          const validated = validateV2Response(reply, request, offerSchema, body);
          if (!validated) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, eventId, error, { conflictId: key })
          : mapDomainError(reply, request, eventId, error),
      );
      if (!result) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.get(
    '/admin/events/:eventId/tiers/:tierId/waitlist',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: offerParams, querystring: adminQueueQuery }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const adminId = requireUserId(request, reply);
      if (!adminId) return reply;
      const { eventId, tierId } = request.params as z.infer<typeof offerParams>;
      const query = request.query as z.infer<typeof adminQueueQuery>;
      const page = await services.waitlist
        .listForAdmin(adminId, eventId, tierId, { ...query, cursor: query.cursor ?? null })
        .catch((error: unknown) => mapDomainError(reply, request, eventId, error));
      if (!page) return reply;
      const body = {
        items: page.items.map(entryDto),
        pageInfo: {
          page: query.cursor ? Math.floor(Number.parseInt(query.cursor, 10) / query.limit) + 1 : 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
          nextCursor: page.nextCursor,
        },
      };
      const validated = validateV2Response(reply, request, adminQueueResponseSchema, body);
      return validated === undefined ? reply : reply.send(validated);
    },
  );
}
