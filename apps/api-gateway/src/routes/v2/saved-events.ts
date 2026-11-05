import { opaqueIdSchema } from '@c1rcle/contracts/client';
import {
  savedEventStateSchema,
  savedEventPageSchema,
  savedEventListQuerySchema,
} from '@c1rcle/contracts/saved-events';
import { z } from 'zod';

import { getSavedEventService } from '../../lib/saved-events.js';
import { validateV2Response } from '../../lib/v2-response-validation.js';

import { requireUserId } from './onboarding.js';
import { mapDomainError } from './partner/events.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export default async function savedEventRoutes(app: FastifyInstance) {
  const service = getSavedEventService();
  const params = z.object({ eventId: opaqueIdSchema });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
  });
  async function run(
    request: FastifyRequest,
    reply: FastifyReply,
    schema: z.ZodType,
    action: (id: string) => Promise<unknown>,
  ) {
    const id = requireUserId(request, reply);
    if (!id) return reply;
    try {
      const result = validateV2Response(reply, request, schema, await action(id));
      return await (result === undefined ? reply : reply.send(result));
    } catch (error) {
      return mapDomainError(reply, request, 'saved-events', error);
    }
  }
  app.get(
    '/saved-events',
    {
      preHandler: [
        app.rateLimit('AUTH_READ'),
        app.validateV2({ querystring: savedEventListQuerySchema }),
      ],
    },
    (request, reply) =>
      run(request, reply, savedEventPageSchema, (id) =>
        service.list(id, savedEventListQuerySchema.parse(request.query).cursor),
      ),
  );
  app.get(
    '/saved-events/:eventId',
    { preHandler: [app.rateLimit('AUTH_READ'), app.validateV2({ params })] },
    (request, reply) =>
      run(request, reply, savedEventStateSchema, (id) =>
        service.state(id, params.parse(request.params).eventId),
      ),
  );
  app.put(
    '/saved-events/:eventId',
    {
      preHandler: [
        app.rateLimit('STANDARD_COMMAND'),
        app.validateV2({ params, body: savedEventStateSchema }),
      ],
    },
    (request, reply) =>
      run(request, reply, savedEventStateSchema, (id) =>
        service.set(
          id,
          params.parse(request.params).eventId,
          savedEventStateSchema.parse(request.body).saved,
        ),
      ),
  );
}
