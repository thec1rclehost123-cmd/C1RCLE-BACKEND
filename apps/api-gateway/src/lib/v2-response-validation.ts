import { buildV2ErrorResponse } from '@c1rcle/contracts';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

/**
 * ─── V2 response validation ─────────────────────────────────────────────────
 * Every V2 success payload is validated against its zod schema before
 * serialization (defense against leaking raw Firestore docs). A mismatch is a
 * server bug — 500, never a partial/raw payload.
 */
export function validateV2Response(
  reply: FastifyReply,
  request: FastifyRequest,
  schema: z.ZodType,
  payload: unknown,
): unknown {
  const result = schema.safeParse(payload);
  if (result.success) return payload;
  const issues = result.error.issues ?? [];
  request.log.error(
    { url: request.url, issues },
    'V2 response failed schema validation — payload not sent',
  );
  const status = 500;
  reply.status(status).send(
    buildV2ErrorResponse({
      status,
      message: 'Internal response validation failure',
      code: 'server',
      requestId: request.id,
    }),
  );
  return undefined;
}
