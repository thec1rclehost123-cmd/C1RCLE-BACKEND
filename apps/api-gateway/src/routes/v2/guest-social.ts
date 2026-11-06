import { opaqueIdSchema, idempotencyKeySchema } from '@c1rcle/contracts/client';
import {
  guestSocialPrivacySchema,
  guestSocialPrivacyStateSchema,
  socialGuestProfileSchema,
  socialGuestlistSchema,
  socialListQuerySchema,
  socialHiddenEventSchema,
  socialBlockSchema,
  socialReportSchema,
  socialReportReceiptSchema,
  socialEventPolicySchema,
  managedSocialEventsSchema,
} from '@c1rcle/contracts/guest-social';
import { z } from 'zod';

import { getGuestSocialService } from '../../lib/guest-social.js';
import { isIdempotencyConflict, runIdempotent } from '../../lib/v2-idempotency.js';
import { validateV2Response } from '../../lib/v2-response-validation.js';
import { createV2Services } from '../../lib/v2-services.js';

import { requireUserId } from './onboarding.js';
import { mapDomainError } from './partner/events.js';

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export default async function guestSocialRoutes(app: FastifyInstance) {
  const social = getGuestSocialService();
  const existing = createV2Services();
  const userParams = z.object({ userId: opaqueIdSchema });
  const eventParams = z.object({ eventId: opaqueIdSchema });
  const orgParams = z.object({ organizationId: opaqueIdSchema });
  const orgHeaders = z.looseObject({ 'x-organization-id': opaqueIdSchema });
  const replyWith = async (
    request: FastifyRequest,
    reply: FastifyReply,
    schema: z.ZodType,
    run: (id: string) => Promise<unknown>,
    status = 200,
  ) => {
    const id = requireUserId(request, reply);
    if (!id) return reply;
    try {
      const result = await run(id);
      const validated = validateV2Response(reply, request, schema, result);
      return await (validated === undefined ? reply : reply.status(status).send(validated));
    } catch (error) {
      return mapDomainError(reply, request, 'social', error);
    }
  };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
  });
  app.get(
    '/public/events/:eventId/social-policy',
    { preHandler: [app.rateLimit('AUTH_READ'), app.validateV2({ params: eventParams })] },
    async (request, reply) => {
      try {
        return await reply.send(
          socialEventPolicySchema.parse(
            await social.publicEventPolicy(eventParams.parse(request.params).eventId),
          ),
        );
      } catch (error) {
        return mapDomainError(reply, request, 'social-event-policy', error);
      }
    },
  );
  app.get('/social/privacy', { preHandler: app.rateLimit('AUTH_READ') }, (request, reply) =>
    replyWith(request, reply, guestSocialPrivacyStateSchema, (id) => social.getPrivacy(id)),
  );
  app.put(
    '/social/privacy',
    {
      preHandler: [
        app.rateLimit('STANDARD_COMMAND'),
        app.validateV2({ body: guestSocialPrivacySchema }),
      ],
    },
    (request, reply) =>
      replyWith(request, reply, guestSocialPrivacyStateSchema, (id) =>
        social.savePrivacy(id, guestSocialPrivacySchema.parse(request.body)),
      ),
  );
  app.get(
    '/social/profiles/:userId',
    { preHandler: [app.rateLimit('AUTH_READ'), app.validateV2({ params: userParams })] },
    (request, reply) =>
      replyWith(request, reply, socialGuestProfileSchema, (id) =>
        social.getProfile(id, userParams.parse(request.params).userId),
      ),
  );
  app.get(
    '/social/events/:eventId/guestlist',
    {
      preHandler: [
        app.rateLimit('AUTH_READ'),
        app.validateV2({ params: eventParams, querystring: socialListQuerySchema }),
      ],
    },
    (request, reply) =>
      replyWith(request, reply, socialGuestlistSchema, (id) => {
        const query = socialListQuerySchema.parse(request.query);
        return social.guestlist(
          id,
          eventParams.parse(request.params).eventId,
          Number(query.cursor ?? 0),
          query.limit,
        );
      }),
  );
  app.put(
    '/social/events/:eventId/visibility',
    {
      preHandler: [
        app.rateLimit('STANDARD_COMMAND'),
        app.validateV2({ params: eventParams, body: socialHiddenEventSchema }),
      ],
    },
    (request, reply) =>
      replyWith(request, reply, z.null(), async (id) => {
        await social.hideEvent(
          id,
          eventParams.parse(request.params).eventId,
          socialHiddenEventSchema.parse(request.body).hidden,
        );
        return null;
      }),
  );
  app.put(
    '/social/blocks/:userId',
    {
      preHandler: [
        app.rateLimit('STANDARD_COMMAND'),
        app.validateV2({ params: userParams, body: socialBlockSchema }),
      ],
    },
    (request, reply) =>
      replyWith(request, reply, z.null(), async (id) => {
        await social.block(
          id,
          userParams.parse(request.params).userId,
          socialBlockSchema.parse(request.body).blocked,
        );
        return null;
      }),
  );
  app.post(
    '/social/reports/:userId',
    {
      preHandler: [
        app.rateLimit('SENSITIVE_COMMAND'),
        app.validateV2({
          params: userParams,
          headers: z.looseObject({ 'idempotency-key': idempotencyKeySchema }),
          body: socialReportSchema,
        }),
      ],
    },
    async (request, reply) => {
      const id = requireUserId(request, reply);
      if (!id) return reply;
      const targetId = userParams.parse(request.params).userId;
      const body = socialReportSchema.parse(request.body);
      try {
        await social.requireAccess(id);
        const result = await runIdempotent({
          idempotency: existing.idempotency,
          request,
          actorId: id,
          commandName: 'social.guest.report',
          idempotencyKey: request.v2Headers?.['idempotency-key'],
          context: { path: { targetId }, body },
          run: async () => ({
            statusCode: 201,
            body: socialReportReceiptSchema.parse(
              await social.report(id, targetId, body.category, body.reason),
            ),
          }),
        });
        return await reply.status(result.statusCode).send(result.body);
      } catch (error) {
        return mapDomainError(
          reply,
          request,
          'social-report',
          error,
          isIdempotencyConflict(error)
            ? { conflictId: request.v2Headers?.['idempotency-key'] }
            : undefined,
        );
      }
    },
  );
  app.get(
    '/organizations/:organizationId/social-events',
    {
      preHandler: [
        app.rateLimit('AUTH_READ'),
        app.validateV2({ params: orgParams, headers: orgHeaders }),
        app.requirePermission('event.update'),
      ],
    },
    (request, reply) =>
      replyWith(request, reply, managedSocialEventsSchema, () =>
        social.managedEvents(existing.actor(request)),
      ),
  );
  app.patch(
    '/organizations/:organizationId/social-events/:eventId',
    {
      preHandler: [
        app.rateLimit('STANDARD_COMMAND'),
        app.validateV2({
          params: orgParams.extend({ eventId: opaqueIdSchema }),
          headers: orgHeaders,
          body: socialEventPolicySchema,
        }),
        app.requirePermission('event.update'),
      ],
    },
    (request, reply) =>
      replyWith(request, reply, socialEventPolicySchema, () =>
        social.setEventPolicy(
          existing.actor(request),
          eventParams.parse(request.params).eventId,
          socialEventPolicySchema.parse(request.body).enabled,
        ),
      ),
  );
}
