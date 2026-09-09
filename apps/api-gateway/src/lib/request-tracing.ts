import crypto from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';

/**
 * ─── Request correlation tracing ──────────────────────────────────────────────
 * Single home of `x-request-id` generation and echo. The eventual Nginx edge
 * will be the authoritative generator. Until then, Fastify generates IDs for
 * untrusted/direct traffic and only accepts a bounded incoming ID from a
 * connection whose peer is a configured trusted proxy.
 */

export type TrustedProxyChecker = (address: string | undefined) => boolean;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isValidRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}

/** Generate an ID, accepting an incoming ID only from a trusted proxy peer. */
export function genReqId(
  req: IncomingMessage,
  isTrustedProxy: TrustedProxyChecker = () => false,
): string {
  const header = req.headers['x-request-id'];
  if (
    typeof header === 'string' &&
    isValidRequestId(header) &&
    isTrustedProxy(req.socket?.remoteAddress)
  ) {
    return header;
  }
  return crypto.randomUUID();
}

export function createRequestIdGenerator(isTrustedProxy: TrustedProxyChecker) {
  return (req: IncomingMessage): string => genReqId(req, isTrustedProxy);
}

/** Echo the request id on the response. */
export async function onRequestHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header('x-request-id', request.id);
}
