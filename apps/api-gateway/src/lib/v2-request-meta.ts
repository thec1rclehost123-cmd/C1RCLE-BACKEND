import type { FastifyRequest } from 'fastify';

export interface V2RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Extracts the caller context Fastify makes available on every request —
 * the actor's IP and `User-Agent`. Admin audit records carry both
 * (`AdminAuditRecord.ipAddress`/`userAgent`); the source-of-truth audit
 * trail exists so a security question ("who did that, from where, on what
 * device?") can be answered after the fact even when nothing else is left.
 *
 * The values are best-effort, never validated: Fastify's `request.ip` is
 * always a string (optionally spoofable behind a proxy unless trust-proxy is
 * configured) and the `user-agent` header may be absent or empty. Both stay
 * optional on the wire record for exactly that reason.
 */
export function requestMeta(request: {
  ip?: string;
  headers?: FastifyRequest['headers'];
}): V2RequestMeta {
  const ua = request.headers?.['user-agent'];
  return {
    ipAddress: request.ip,
    userAgent: typeof ua === 'string' ? ua : undefined,
  };
}
