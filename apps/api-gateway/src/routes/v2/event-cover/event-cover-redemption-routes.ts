import {
  createEventCoverRedemptionChallengeSchema,
  eventCoverRedemptionChallengeDtoSchema,
  idempotencyKeySchema,
} from '@c1rcle/contracts/client';
import { NotFoundError } from '@c1rcle/core/domain';
import { z } from 'zod';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

const services = createV2Services();
const challengeParams = z.object({ challengeId: z.string().min(1).max(100) });
const commandHeaders = z.object({ 'idempotency-key': idempotencyKeySchema });

function challengeDto(challenge: {
  id: string;
  entitlementId: string;
  eventId: string;
  amountPaise: number;
  grossSpendPaise: number;
  categories: readonly string[];
  status: 'pending' | 'confirmed' | 'consumed' | 'expired';
  expiresAt: string;
}) {
  return {
    id: challenge.id,
    entitlementId: challenge.entitlementId,
    eventId: challenge.eventId,
    amountPaise: challenge.amountPaise,
    grossSpendPaise: challenge.grossSpendPaise,
    categories: [...challenge.categories],
    status:
      challenge.status === 'pending' && Date.parse(challenge.expiresAt) <= Date.now()
        ? 'expired'
        : challenge.status,
    expiresAt: challenge.expiresAt,
  };
}

export default async function eventCoverRedemptionRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/event-cover/redemption-challenges',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          headers: commandHeaders,
          body: createEventCoverRedemptionChallengeSchema,
        }),
        fastify.requirePermission('door.manage'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const actor = services.actor(request);
      const body = request.body as z.infer<typeof createEventCoverRedemptionChallengeSchema>;
      const headers = request.v2Headers ?? {};
      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'event-cover.redemption-challenge.create',
        idempotencyKey: headers['idempotency-key'],
        context: { path: {}, body },
        run: async () => {
          const challenge = await services.eventCoverRedemption.createChallenge(
            actor,
            body,
            headers['idempotency-key'],
          );
          const validated = validateV2Response(
            reply,
            request,
            eventCoverRedemptionChallengeDtoSchema,
            challengeDto(challenge),
          );
          if (!validated) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, 'event-cover', error, {
              conflictId: headers['idempotency-key'],
            })
          : mapDomainError(reply, request, 'event-cover', error),
      );
      if (!result) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.get(
    '/wallet/event-cover-redemption-challenges/:challengeId',
    {
      preHandler: [fastify.rateLimit('AUTH_READ'), fastify.validateV2({ params: challengeParams })],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { challengeId } = request.params as z.infer<typeof challengeParams>;
      const result = await services.eventCoverRedemption
        .getChallengeForGuest(services.actor(request), challengeId)
        .catch((error: unknown) => mapDomainError(reply, request, 'event-cover', error));
      if (!result) return reply;
      const validated = validateV2Response(
        reply,
        request,
        eventCoverRedemptionChallengeDtoSchema,
        challengeDto(result),
      );
      if (!validated) return reply;
      return reply.send(validated);
    },
  );

  fastify.get(
    '/event-cover/redemption-challenges/:challengeId',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ params: challengeParams }),
        fastify.requirePermission('door.manage'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { challengeId } = request.params as z.infer<typeof challengeParams>;
      const result = await services.eventCoverRedemption
        .getChallengeForVenue(services.actor(request), challengeId)
        .catch((error: unknown) => mapDomainError(reply, request, 'event-cover', error));
      if (!result) return reply;
      const validated = validateV2Response(
        reply,
        request,
        eventCoverRedemptionChallengeDtoSchema,
        challengeDto(result),
      );
      if (!validated) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/wallet/event-cover-redemption-challenges/:challengeId/confirm',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: challengeParams, body: z.object({}).strict() }),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { challengeId } = request.params as z.infer<typeof challengeParams>;
      const result = await services.eventCoverRedemption
        .confirmChallenge(services.actor(request), challengeId)
        .catch((error: unknown) => mapDomainError(reply, request, 'event-cover', error));
      if (!result) return reply;
      const validated = validateV2Response(
        reply,
        request,
        eventCoverRedemptionChallengeDtoSchema,
        challengeDto(result),
      );
      if (!validated) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/event-cover/redemption-challenges/:challengeId/consume',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: challengeParams, body: z.object({}).strict() }),
        fastify.requirePermission('door.manage'),
      ],
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const { challengeId } = request.params as z.infer<typeof challengeParams>;
      const result = await services.eventCoverRedemption
        .consumeChallenge(services.actor(request), challengeId)
        .catch((error: unknown) => mapDomainError(reply, request, 'event-cover', error));
      if (!result) return reply;
      const challenge = await services
        .repos()
        .eventCoverAccounts.getRedemptionChallenge(challengeId);
      if (!challenge) {
        return mapDomainError(
          reply,
          request,
          'event-cover',
          new NotFoundError('Cover challenge', challengeId),
        );
      }
      const validated = validateV2Response(
        reply,
        request,
        eventCoverRedemptionChallengeDtoSchema,
        challengeDto(challenge),
      );
      if (!validated) return reply;
      return reply.send(validated);
    },
  );
}
