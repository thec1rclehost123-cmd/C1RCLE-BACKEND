import { buildV2ErrorResponse } from '@c1rcle/contracts';
import {
  signupRequestSchema,
  loginRequestSchema,
  authBridgeResponseSchema,
  sessionSchema,
  noContentSchema,
} from '@c1rcle/contracts/client';

import { validateV2Response } from '../../../lib/v2-response-validation.js';
import { toWebHeaders, type BetterAuthInstance } from '../../../plugins/auth.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

/**
 * ─── B10 auth bridge routes ─────────────────────────────────────────────────
 * Thin routes over Better Auth's server API (`auth.api.*`, called directly —
 * not proxied through `auth.handler`) so the JSON shape stays exactly the
 * frontend contract (`{user, accessToken, expiresAt}` / `Session{user,
 * expiresAt}`), never Better Auth's native response shape. The httpOnly
 * session cookie Better Auth sets is forwarded through untouched; the access
 * token is the Bearer plugin's session token (`set-auth-token` header) — no
 * separate JWT minted (resolves decisions.md open question #3).
 *
 * Not registered when `auth` is null (`STORAGE_DRIVER=memory`) — see
 * `docs/roadmap/phase-00-foundation.md`.
 */
export default async function authRoutes(
  fastify: FastifyInstance,
  options: { auth: BetterAuthInstance | null },
) {
  const { auth } = options;

  fastify.post(
    '/signup',
    { preHandler: fastify.validateV2({ body: signupRequestSchema }) },
    async (request, reply) => {
      if (!auth) return sendAuthUnavailable(reply, request);
      const body = request.body as z.infer<typeof signupRequestSchema>;
      const result = await runAuthFlow(auth, request, reply, () =>
        auth.api.signUpEmail({
          // `role` is a required additional field (better-auth's generated
          // type confirmed this at typecheck time) — always server-set,
          // never client-supplied (`signupRequestSchema` has no `role` field).
          body: {
            email: body.email,
            password: body.password,
            name: body.displayName,
            role: 'partner',
          },
          headers: toWebHeaders(request.headers),
          asResponse: true,
        }),
      );
      if (result === undefined) return reply;
      const validated = validateV2Response(reply, request, authBridgeResponseSchema, result);
      if (validated === undefined) return reply;
      return reply.status(201).send(validated);
    },
  );

  fastify.post(
    '/login',
    { preHandler: fastify.validateV2({ body: loginRequestSchema }) },
    async (request, reply) => {
      if (!auth) return sendAuthUnavailable(reply, request);
      const body = request.body as z.infer<typeof loginRequestSchema>;
      const result = await runAuthFlow(auth, request, reply, () =>
        auth.api.signInEmail({
          body: { email: body.email, password: body.password },
          headers: toWebHeaders(request.headers),
          asResponse: true,
        }),
      );
      if (result === undefined) return reply;
      const validated = validateV2Response(reply, request, authBridgeResponseSchema, result);
      if (validated === undefined) return reply;
      return reply.status(200).send(validated);
    },
  );

  // Better Auth extends session expiry on read within its `updateAge` window
  // rather than rotating the token string (see phase-00 Session Log) — this
  // route re-validates the httpOnly cookie and returns the (possibly now
  // longer-lived) session, which is what "no session breakage on reload" needs.
  fastify.post('/refresh', async (request, reply) => {
    if (!auth) return sendAuthUnavailable(reply, request);
    const session = await auth.api
      .getSession({ headers: toWebHeaders(request.headers) })
      .catch(() => null);
    if (!session?.user) return sendUnauthorized(reply, request);
    const payload = {
      user: toUserDto(session.user),
      accessToken: session.session.token,
      expiresAt: toUnixMs(session.session.expiresAt),
    };
    const validated = validateV2Response(reply, request, authBridgeResponseSchema, payload);
    if (validated === undefined) return reply;
    return reply.status(200).send(validated);
  });

  fastify.post('/logout', async (request, reply) => {
    if (!auth) return sendAuthUnavailable(reply, request);
    const response = await auth.api.signOut({
      headers: toWebHeaders(request.headers),
      asResponse: true,
    });
    forwardSetCookie(reply, response);
    return reply.status(204).send();
  });

  fastify.get('/session', async (request, reply) => {
    if (!auth) return sendAuthUnavailable(reply, request);
    const session = await auth.api
      .getSession({ headers: toWebHeaders(request.headers) })
      .catch(() => null);
    if (!session?.user) return sendUnauthorized(reply, request);
    const payload = {
      user: toUserDto(session.user),
      expiresAt: toUnixMs(session.session.expiresAt),
    };
    const validated = validateV2Response(reply, request, sessionSchema, payload);
    if (validated === undefined) return reply;
    return reply.status(200).send(validated);
  });

  void noContentSchema; // reserved for the 204 logout response's (absent) body
}

/**
 * Runs a Better Auth `asResponse: true` call, forwards its `Set-Cookie`, and
 * reshapes the result into `{user, accessToken, expiresAt}`. Returns
 * `undefined` after the reply has already been sent (error path).
 */
async function runAuthFlow(
  auth: BetterAuthInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  call: () => Promise<Response>,
): Promise<{ user: unknown; accessToken: string; expiresAt: number } | undefined> {
  let response: Response;
  try {
    response = await call();
  } catch (error) {
    return sendAuthError(reply, request, error);
  }
  if (!response.ok) return forwardAuthErrorResponse(reply, request, response);

  forwardSetCookie(reply, response);
  const accessToken = response.headers.get('set-auth-token');

  // Re-read the session through the just-set cookie for a reliably-shaped
  // {session, user} — sidesteps depending on signUpEmail/signInEmail's own
  // (loosely documented) body shape.
  const followUpHeaders = toWebHeaders(request.headers);
  const cookiePair = response.headers.getSetCookie()[0]?.split(';')[0];
  if (cookiePair) followUpHeaders.set('cookie', cookiePair);
  const session = await auth.api.getSession({ headers: followUpHeaders }).catch(() => null);
  if (!session?.user) return sendUnauthorized(reply, request);

  return {
    user: toUserDto(session.user),
    accessToken: accessToken ?? session.session.token,
    expiresAt: toUnixMs(session.session.expiresAt),
  };
}

function forwardSetCookie(reply: FastifyReply, response: Response): void {
  for (const cookie of response.headers.getSetCookie()) {
    void reply.header('set-cookie', cookie);
  }
}

async function forwardAuthErrorResponse(
  reply: FastifyReply,
  request: FastifyRequest,
  response: Response,
): Promise<undefined> {
  const status = response.status === 422 ? 422 : response.status >= 500 ? 500 : 400;
  let message = 'Authentication request failed';
  try {
    const body = (await response.json()) as { message?: string };
    if (body?.message) message = body.message;
  } catch {
    // Non-JSON error body — keep the generic message.
  }
  reply.status(status).send(
    buildV2ErrorResponse({
      status,
      message,
      requestId: request.id,
    }),
  );
  return undefined;
}

function sendAuthError(reply: FastifyReply, request: FastifyRequest, error: unknown): undefined {
  const known = error as { status?: number; message?: string };
  const status = typeof known?.status === 'number' ? known.status : 400;
  reply.status(status).send(
    buildV2ErrorResponse({
      status,
      message: known?.message ?? 'Authentication request failed',
      requestId: request.id,
    }),
  );
  return undefined;
}

function sendUnauthorized(reply: FastifyReply, request: FastifyRequest): undefined {
  reply.status(401).send(
    buildV2ErrorResponse({
      status: 401,
      code: 'unauthorized',
      message: 'No active session',
      requestId: request.id,
    }),
  );
  return undefined;
}

function sendAuthUnavailable(reply: FastifyReply, request: FastifyRequest): undefined {
  // STORAGE_DRIVER=memory: no persistent store backs auth (see module doc).
  reply.status(503).send(
    buildV2ErrorResponse({
      status: 503,
      code: 'server',
      message: 'Auth is not available on the memory storage driver',
      requestId: request.id,
    }),
  );
  return undefined;
}

function toUnixMs(value: unknown): number {
  return new Date(value as string | number | Date).getTime();
}

function toUserDto(user: { id: string; email: string; name: string; image?: string | null }): {
  id: string;
  email: string;
  displayName: string;
  role: 'guest' | 'partner' | 'admin';
  avatarUrl: string | null;
} {
  return {
    id: user.id,
    email: user.email,
    displayName: user.name,
    // Phase 0 scope is partner-dashboard auth only; guest/admin auth are
    // later phases (docs/roadmap/ROADMAP.md) and will need a real role source.
    role: 'partner',
    avatarUrl: user.image ?? null,
  };
}
