import { adminUserDtoSchema, idempotencyKeySchema, opaqueIdSchema } from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { PlatformUser } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin user actions (Phase 7 trust & safety) ─────────────────────────────
 *
 * `USER_BAN`/`USER_UNBAN` are TIER2 — reversible but costly, matching v1's
 * `setUserBanStatus`. Ban state lives in its own `v2_user_bans` collection,
 * never on the Better Auth user record (`UserAccountRepository` is
 * read-only by design). Same direct-command shape as `venue-actions.ts`.
 */

const services = createV2Services();

const userIdParam = z.object({ userId: opaqueIdSchema });
const banBodySchema = z.looseObject({ reason: z.string().max(2000).optional() });
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });

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

export default async function adminUserActionRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/admin/users/:userId/ban',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({
          params: userIdParam,
          headers: commandHeaders,
          body: banBodySchema.optional(),
        }),
      ],
    },
    async (request, reply) => {
      const adminUserId = requireUserId(request, reply);
      if (adminUserId === undefined) return reply;
      const { userId } = request.params as z.infer<typeof userIdParam>;
      const body = (request.body as z.infer<typeof banBodySchema> | undefined) ?? {};
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: adminUserId,
        commandName: 'admin.user.ban',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { userId }, body: {} },
        run: async () => {
          const user = await services.adminOps.banUser(adminUserId, userId, body.reason);
          const validated = validateV2Response(reply, request, adminUserDtoSchema, userToDto(user));
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, userId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, userId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  fastify.post(
    '/admin/users/:userId/unban',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: userIdParam, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const adminUserId = requireUserId(request, reply);
      if (adminUserId === undefined) return reply;
      const { userId } = request.params as z.infer<typeof userIdParam>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: adminUserId,
        commandName: 'admin.user.unban',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { userId }, body: {} },
        run: async () => {
          const user = await services.adminOps.unbanUser(adminUserId, userId);
          const validated = validateV2Response(reply, request, adminUserDtoSchema, userToDto(user));
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, userId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, userId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}
