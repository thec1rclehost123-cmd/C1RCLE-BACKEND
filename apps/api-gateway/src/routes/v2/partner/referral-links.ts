import {
  opaqueIdSchema,
  idempotencyKeySchema,
  paginationQuerySchema,
  referralLinkDtoSchema,
  createReferralLinkSchema,
  paginatedSchema,
} from '@c1rcle/contracts/client';
import { z } from 'zod';

import type { ReferralLink } from '@c1rcle/core/domain';

import { isIdempotencyConflict, runIdempotent } from '../../../lib/v2-idempotency.js';
import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { createV2Services } from '../../../lib/v2-services.js';

import { mapDomainError } from './events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Promoter referral links (Phase 1) ───────────────────────────────────────
 *
 * The partner-side surface: create, list and deactivate. The guest-side click
 * tracker belongs to Phase 4's public routes — a click is anonymous traffic,
 * not a partner action, and mixing it in here would put an unauthenticated
 * endpoint behind partner policy.
 */

const services = createV2Services();

const eventIdParam = z.object({ eventId: opaqueIdSchema });
const linkIdParam = z.object({ referralLinkId: opaqueIdSchema });

const readHeaders = z.looseObject({ 'x-organization-id': opaqueIdSchema });
const commandHeaders = readHeaders.extend({ 'idempotency-key': idempotencyKeySchema });

const linkListSchema = paginatedSchema(referralLinkDtoSchema);

export default async function partnerReferralLinkRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/events/:eventId/referral-links',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({
          params: eventIdParam,
          querystring: paginationQuerySchema,
          headers: readHeaders,
        }),
        fastify.requirePermission('event.read'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const query = request.query as z.infer<typeof paginationQuerySchema>;
      const actor = services.actor(request);
      const page = await services.referralLinks
        .listForEvent(actor, eventId, { limit: query.limit, cursor: query.cursor ?? null })
        .catch((error: unknown) =>
          mapDomainError(reply, request, eventId, error, { hideForbidden: true }),
        );
      if (page === undefined) return reply;

      const payload = {
        items: page.items.map(linkToDto),
        pageInfo: {
          page: 1,
          pageSize: query.limit,
          total: page.total,
          hasNextPage: page.nextCursor !== null,
        },
      };
      const validated = validateV2Response(reply, request, linkListSchema, payload);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  fastify.post(
    '/events/:eventId/referral-links',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({
          params: eventIdParam,
          headers: commandHeaders,
          body: createReferralLinkSchema,
        }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      const { eventId } = request.params as z.infer<typeof eventIdParam>;
      const body = request.body as z.infer<typeof createReferralLinkSchema>;
      const actor = services.actor(request);
      const v2Headers = request.v2Headers ?? {};

      const result = await runIdempotent({
        idempotency: services.idempotency,
        request,
        actorId: actor.userId,
        commandName: 'referral-links.create',
        idempotencyKey: v2Headers['idempotency-key'],
        context: { path: { eventId }, body },
        run: async () => {
          const link = await services.referralLinks.create(actor, {
            eventId,
            promoterId: body.promoterId,
            code: body.code,
            label: body.label,
          });
          const validated = validateV2Response(
            reply,
            request,
            referralLinkDtoSchema,
            linkToDto(link),
          );
          if (validated === undefined) throw new Error('v2 response validation failed');
          return { statusCode: 201, body: validated };
        },
      }).catch((error: unknown) =>
        isIdempotencyConflict(error)
          ? mapDomainError(reply, request, eventId, error, {
              conflictId: v2Headers['idempotency-key'],
            })
          : mapDomainError(reply, request, eventId, error),
      );
      if (result === undefined) return reply;
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // Deactivation, not deletion: a link that stops attributing new orders must
  // still exist so past attributions remain explicable.
  fastify.post(
    '/referral-links/:referralLinkId/deactivate',
    {
      preHandler: [
        fastify.rateLimit('STANDARD_COMMAND'),
        fastify.validateV2({ params: linkIdParam, headers: commandHeaders }),
        fastify.requirePermission('event.update'),
      ],
    },
    async (request, reply) => {
      const { referralLinkId } = request.params as z.infer<typeof linkIdParam>;
      const actor = services.actor(request);
      const link = await services.referralLinks
        .deactivate(actor, referralLinkId)
        .catch((error: unknown) => mapDomainError(reply, request, referralLinkId, error));
      if (link === undefined) return reply;

      const validated = validateV2Response(reply, request, referralLinkDtoSchema, linkToDto(link));
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );
}

function linkToDto(link: ReferralLink) {
  return {
    id: link.id,
    eventId: link.eventId,
    promoterId: link.promoterId,
    organizationId: link.organizationId,
    code: link.code,
    label: link.label,
    isActive: link.isActive,
    clicks: link.clicks,
    conversions: link.conversions,
    version: link.version,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}
