import { guestProfileDtoSchema, upsertGuestProfileSchema } from '@c1rcle/contracts/client';
import { NotFoundError } from '@c1rcle/core/domain';

import type { GuestProfile } from '@c1rcle/core/domain';

import { validateV2Response } from '../../lib/v2-response-validation.js';
import { createV2Services } from '../../lib/v2-services.js';

import { requireUserId } from './onboarding.js';
import { mapDomainError } from './partner/events.js';

import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';

/**
 * ─── Guest profile routes ────────────────────────────────────────────────────
 * Session-scoped, never org-scoped: a guest belongs to no organization, so no
 * `X-Organization-Id` and no `requirePermission` (same posture as
 * `onboarding/me`). Ownership is the session user id, threaded explicitly.
 *
 * `PUT` is a full-replace upsert and needs no idempotency key or `If-Match`:
 * the same body converges to the same document, so retries are safe by
 * construction (contrast `onboarding.start`, where a retry would mint a
 * second application).
 */

const services = createV2Services();

export default async function guestProfileRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/profile/me',
    { preHandler: [fastify.rateLimit('AUTH_READ')] },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;

      const found = await services.guestProfile
        .getMine(userId)
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (found === undefined) return reply;
      if (found === null) {
        mapDomainError(reply, request, userId, new NotFoundError('Guest profile', userId));
        return reply;
      }

      const validated = validateV2Response(reply, request, guestProfileDtoSchema, toDto(found));
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.put(
    '/profile/me',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ body: upsertGuestProfileSchema }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const body = request.body as z.infer<typeof upsertGuestProfileSchema>;

      const saved = await services.guestProfile
        .upsertMine(userId, {
          displayName: body.displayName,
          dateOfBirth: body.dateOfBirth,
          city: body.city,
          tastes: body.tastes,
          intents: body.intents,
        })
        .catch((error: unknown) => mapDomainError(reply, request, userId, error));
      if (saved === undefined) return reply;

      const validated = validateV2Response(reply, request, guestProfileDtoSchema, toDto(saved));
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}

export function toDto(profile: GuestProfile) {
  return {
    userId: profile.userId,
    displayName: profile.displayName,
    dateOfBirth: profile.dateOfBirth,
    city: profile.city,
    tastes: profile.tastes,
    intents: profile.intents,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}
