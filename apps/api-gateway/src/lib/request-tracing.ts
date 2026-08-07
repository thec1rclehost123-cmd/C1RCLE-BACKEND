import crypto from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';

/**
 * ─── Request correlation tracing ──────────────────────────────────────────────
 * Single home of `x-request-id` generation and echo.
 */

/** Accept a client-supplied `x-request-id` (echos it), else mint a UUID. */
export function genReqId(req: IncomingMessage): string {
  const header = req.headers['x-request-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  return crypto.randomUUID();
}

/** Echo the request id on the response. */
export async function onRequestHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header('x-request-id', request.id);
}
