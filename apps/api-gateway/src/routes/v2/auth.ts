import { buildV2ErrorResponse } from '@c1rcle/contracts';
import { roleSchema, sessionSchema, userSchema } from '@c1rcle/contracts/client';
import { z } from 'zod';

import { getAuth } from '../../auth/auth-context.js';
import { validateV2Response } from '../../lib/v2-response-validation.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── V2 auth routes (B10) ────────────────────────────────────────────────────
 *
 * The frontend contract is fixed and non-negotiable:
 *
 *   POST /api/v2/auth/login    → httpOnly cookie + { user, accessToken, expiresAt }
 *   POST /api/v2/auth/refresh  → rotates, same shape  (the reload-restore path)
 *   POST /api/v2/auth/logout   → destroys the session, clears the cookie
 *   GET  /api/v2/auth/session  → { user, expiresAt } or 401
 *
 * `accessToken` IS the Better Auth session token: the cookie and the in-memory
 * bearer are the same credential, so there is exactly one thing to revoke and
 * one authority to check. Rotation happens on refresh.
 */

const credentialsSchema = z
  .object({
    email: z.email(),
    password: z.string().min(8).max(256),
  })
  .strict();

const signUpSchema = credentialsSchema
  .extend({
    displayName: z.string().min(1).max(120),
  })
  .strict();

/** The login/refresh payload: a Session plus the token the client holds in memory. */
const authSessionSchema = sessionSchema.extend({ accessToken: z.string().min(1) });

interface BetterAuthUser {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role?: string | null;
}

export default async function authRoutes(fastify: FastifyInstance) {
  // ── LOGIN ─────────────────────────────────────────────────────────────────
  fastify.post(
    '/auth/login',
    {
      preHandler: [
        // Credential stuffing surface: the tightest bucket we have.
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ body: credentialsSchema }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof credentialsSchema>;
      const auth = getAuth(fastify);

      const response = await auth.api.signInEmail({
        body: { email: body.email, password: body.password },
        headers: toHeaders(request),
        asResponse: true,
      });

      if (!response.ok) {
        // Never distinguish "no such user" from "wrong password".
        return sendUnauthorized(reply, request, 'Invalid email or password');
      }

      const payload = (await response.json()) as { token: string; user: BetterAuthUser };
      forwardCookies(response, reply);
      return sendSession(reply, request, payload.token, payload.user);
    },
  );

  // ── SIGN UP ───────────────────────────────────────────────────────────────
  fastify.post(
    '/auth/sign-up',
    {
      preHandler: [
        fastify.rateLimit('SENSITIVE_COMMAND'),
        fastify.validateV2({ body: signUpSchema }),
      ],
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof signUpSchema>;
      const auth = getAuth(fastify);

      const response = await auth.api.signUpEmail({
        body: { email: body.email, password: body.password, name: body.displayName },
        headers: toHeaders(request),
        asResponse: true,
      });

      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { message?: string } | null;
        void reply.status(409).send(
          buildV2ErrorResponse({
            status: 409,
            code: 'conflict',
            message: detail?.message ?? 'Could not create the account',
            requestId: request.id,
          }),
        );
        return reply;
      }

      const payload = (await response.json()) as { token: string; user: BetterAuthUser };
      forwardCookies(response, reply);
      return sendSession(reply, request, payload.token, payload.user, 201);
    },
  );

  // ── REFRESH (page reload restores the session from the cookie) ────────────
  fastify.post(
    '/auth/refresh',
    { preHandler: fastify.rateLimit('SENSITIVE_COMMAND') },
    async (request, reply) => {
      const auth = getAuth(fastify);
      const current = await auth.api.getSession({ headers: toHeaders(request) });
      if (!current) return sendUnauthorized(reply, request, 'No active session');

      // Rotation: Better Auth issues a fresh token and re-sets the cookie.
      const response = await auth.api.getSession({
        headers: toHeaders(request),
        query: { disableCookieCache: true },
        asResponse: true,
      });
      forwardCookies(response, reply);

      return sendSession(reply, request, current.session.token, current.user);
    },
  );

  // ── SESSION ───────────────────────────────────────────────────────────────
  fastify.get('/auth/session', async (request, reply) => {
    const auth = getAuth(fastify);
    const current = await auth.api.getSession({ headers: toHeaders(request) });
    if (!current) return sendUnauthorized(reply, request, 'No active session');

    const payload = {
      user: toUserDto(current.user),
      expiresAt: new Date(current.session.expiresAt).getTime(),
    };
    const validated = validateV2Response(reply, request, sessionSchema, payload);
    if (validated === undefined) return reply;
    return reply.send(validated);
  });

  // ── LOGOUT ────────────────────────────────────────────────────────────────
  fastify.post('/auth/logout', async (request, reply) => {
    const auth = getAuth(fastify);
    const response = await auth.api.signOut({ headers: toHeaders(request), asResponse: true });
    forwardCookies(response, reply);
    // 204: revocation is idempotent — logging out twice is not an error.
    return reply.status(204).send();
  });
}

/** Fastify headers → the Web `Headers` Better Auth expects. */
function toHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

/** Passes Better Auth's Set-Cookie headers through untouched (httpOnly intact). */
function forwardCookies(response: Response, reply: FastifyReply): void {
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) {
    void reply.header('set-cookie', cookies);
    return;
  }
  const single = response.headers.get('set-cookie');
  if (single) void reply.header('set-cookie', single);
}

function toUserDto(user: BetterAuthUser) {
  const role = roleSchema.safeParse(user.role);
  return {
    id: user.id,
    email: user.email,
    displayName: user.name ?? user.email,
    // Unknown/absent role falls back to the least privileged one, never up.
    role: role.success ? role.data : 'guest',
    avatarUrl: user.image ?? null,
  };
}

function sendSession(
  reply: FastifyReply,
  request: FastifyRequest,
  token: string,
  user: BetterAuthUser,
  status = 200,
): FastifyReply {
  const parsedUser = userSchema.safeParse(toUserDto(user));
  if (!parsedUser.success) {
    void reply.status(500).send(
      buildV2ErrorResponse({
        status: 500,
        code: 'server',
        message: 'Internal server error',
        requestId: request.id,
      }),
    );
    return reply;
  }

  const payload = {
    user: parsedUser.data,
    // Epoch ms — the frontend Session contract. The backend owns real expiry;
    // this mirrors the session cookie's own lifetime.
    expiresAt: Date.now() + sessionTtlMs(request),
    accessToken: token,
  };

  const validated = validateV2Response(reply, request, authSessionSchema, payload);
  if (validated === undefined) return reply;
  return reply.status(status).send(validated);
}

function sessionTtlMs(request: FastifyRequest): number {
  const config = (
    request.server as unknown as { gatewayConfig?: { AUTH_SESSION_TTL_SECONDS: number } }
  ).gatewayConfig;
  return (config?.AUTH_SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 7) * 1000;
}

function sendUnauthorized(
  reply: FastifyReply,
  request: FastifyRequest,
  message: string,
): FastifyReply {
  void reply.status(401).send(
    buildV2ErrorResponse({
      status: 401,
      code: 'unauthorized',
      message,
      requestId: request.id,
    }),
  );
  return reply;
}
