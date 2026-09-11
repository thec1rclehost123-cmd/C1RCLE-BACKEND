import { adminHostDtoSchema, idempotencyKeySchema, opaqueIdSchema } from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { Organization } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';
import { requireUserId } from '../onboarding.js';
import { mapDomainError } from '../partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin organization actions (Phase 7 admin) ──────────────────────────────
 *
 * `COMMISSION_ADJUST` is TIER3, dual control: raise a proposal on the
 * existing `/admin/proposals` desk (`action: 'COMMISSION_ADJUST'`,
 * `payload: { organizationId, platformFeePercent }`), get it approved by a
 * second admin, then execute here. Same shape as `payouts.ts`'s
 * freeze/release-payout execute routes.
 */

const services = createV2Services();

const proposalIdParam = z.object({ proposalId: opaqueIdSchema });
const commandHeaders = z.looseObject({ 'idempotency-key': idempotencyKeySchema });

function hostToDto(org: Organization) {
  return {
    id: org.id,
    ownerId: org.ownerId,
    name: org.name,
    slug: org.slug,
    status: org.status,
    platformFeePercent: org.platformFeePercent,
    memberCount: org.members.length,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  };
}

export default async function adminOrganizationActionRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/admin/proposals/:proposalId/adjust-commission',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ params: proposalIdParam, headers: commandHeaders }),
      ],
    },
    async (request, reply) => {
      const userId = requireUserId(request, reply);
      if (userId === undefined) return reply;
      const { proposalId } = request.params as z.infer<typeof proposalIdParam>;
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: userId,
        commandName: 'admin.organization.adjust_commission',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { proposalId }, body: {} },
        run: async () => {
          const org = await services.adminOps.adjustCommissionFromProposal(userId, proposalId);
          const validated = validateV2Response(reply, request, adminHostDtoSchema, hostToDto(org));
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 200, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, proposalId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, proposalId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );
}
