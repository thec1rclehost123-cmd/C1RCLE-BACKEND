import { buildV2ErrorResponse, zodToFieldErrors } from '@c1rcle/contracts';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { z } from 'zod';

export interface V2ValidationSchemas {
  body?: z.ZodType;
  querystring?: z.ZodType;
  params?: z.ZodType;
  headers?: z.ZodType;
}

/**
 * 🛡️ V2 Centralized Validation Plugin
 *
 * Parses body + querystring + params + headers and returns 422 with the
 * canonical `fieldErrors` shape. Non-zod errors rethrow. `zodToFieldErrors`
 * prunes `_root` nonsense into real field maps — the strict-body test asserts
 * unknown keys land under `_root` exactly as V1 behavior documents.
 */
export default fp(async (fastify: FastifyInstance) => {
  fastify.decorate('validateV2', (schemas: V2ValidationSchemas) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (schemas.headers) {
          const validated = await schemas.headers.parseAsync(request.headers);
          request.v2Headers = validated as Record<string, string>;
        }
        if (schemas.body) {
          request.body = await schemas.body.parseAsync(request.body);
        }
        if (schemas.querystring) {
          request.query = await schemas.querystring.parseAsync(request.query);
        }
        if (schemas.params) {
          request.params = await schemas.params.parseAsync(request.params);
        }
      } catch (error) {
        if (error instanceof ZodError) {
          fastify.log.warn(
            {
              requestId: request.id,
              url: request.url,
              validationErrors: error.issues,
            },
            'V2 Validation Failed',
          );
          return reply.status(422).send(
            buildV2ErrorResponse({
              status: 422,
              message: 'Validation failed',
              requestId: request.id,
              fieldErrors: zodToFieldErrors(error),
            }),
          );
        }
        throw error;
      }
    };
  });

  fastify.log.info('V2 validation schema plugin initialized');
});

declare module 'fastify' {
  interface FastifyInstance {
    validateV2: (
      schemas: V2ValidationSchemas,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    v2Headers?: Record<string, string>;
  }
}
