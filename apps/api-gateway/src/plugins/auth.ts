/**
 * ─── B10 — Better Auth integration ─────────────────────────────────────────
 * D-001 (docs/architecture/decisions.md): Better Auth, httpOnly cookie session + in-memory
 * bearer access token on the client. `betterAuth-firestore` backs it with the
 * same Firestore project the domain repositories use (B12), under `v2_auth_*`
 * collections — separate from `v2_organizations` etc., but one datastore.
 *
 * `STORAGE_DRIVER=memory` (pnpm test / CI default) does not build a real auth
 * instance — see `docs/roadmap/phase-00-foundation.md` for why: the frozen
 * memory-driver tests exercise routes directly without a login flow, and
 * `lib/v2-services.ts`'s `buildActorContext` keeps its pre-B10 fabricated
 * actor for exactly that driver. `STORAGE_DRIVER=firestore` is where auth is
 * actually enforced.
 */
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { firestoreAdapter } from 'better-auth-firestore';
import fp from 'fastify-plugin';

import type { OrganizationRepository, OrganizationRole, Capability } from '@c1rcle/core/domain';
import type { Firestore } from '@c1rcle/core/infrastructure';

import type { GatewayConfig } from '../config/index.js';
import type { FastifyInstance } from 'fastify';

export type BetterAuthInstance = ReturnType<typeof buildBetterAuth>;

const FRONTEND_DEV_ORIGINS = [
  'http://localhost:3000', // guest-portal
  'http://localhost:3001', // partner-dashboard
  'http://localhost:3002', // admin-console
];

/** Builds the Better Auth instance. Only called when `STORAGE_DRIVER=firestore`. */
export function buildBetterAuth(gw: GatewayConfig, db: Firestore) {
  return betterAuth({
    secret: gw.BETTER_AUTH_SECRET,
    baseURL: gw.BETTER_AUTH_URL,
    database: firestoreAdapter({
      firestore: db,
      collections: {
        users: 'v2_auth_users',
        sessions: 'v2_auth_sessions',
        accounts: 'v2_auth_accounts',
        verificationTokens: 'v2_auth_verification_tokens',
      },
    }),
    emailAndPassword: {
      enabled: true,
    },
    // Confirmed-minimal shape (better-auth docs, checked 2026-08-13) — no
    // relied-on default-value mechanism here; routes/auth/index.ts always
    // passes `role` explicitly at signup instead of trusting a schema default.
    user: {
      additionalFields: {
        role: { type: 'string' },
      },
    },
    advanced: {
      useSecureCookies: gw.NODE_ENV === 'production',
    },
    trustedOrigins: FRONTEND_DEV_ORIGINS,
    plugins: [bearer()],
  });
}

export interface AuthContextPluginOptions {
  auth: BetterAuthInstance | null;
  organizations: OrganizationRepository;
}

/** Fastify request headers (string | string[] | undefined) → standard `Headers`, for `auth.api.*`. */
export function toWebHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') result.set(key, value);
    else if (Array.isArray(value)) result.set(key, value.join(', '));
  }
  return result;
}

/**
 * Global request hook: resolves the Better Auth session (if any) into
 * `request.user`, then resolves real organization membership (if an
 * `X-Organization-Id` header is present) into `request.authContext`.
 * `lib/v2-services.ts`'s `buildActorContext` reads both, synchronously,
 * after this hook has already run. No-ops entirely when `auth` is null
 * (memory driver).
 */
export default fp(async (fastify: FastifyInstance, options: AuthContextPluginOptions) => {
  const { auth, organizations } = options;
  if (!auth) return;

  fastify.addHook('onRequest', async (request) => {
    const sessionResult = await auth.api
      .getSession({ headers: toWebHeaders(request.headers) })
      .catch(() => null);
    if (!sessionResult?.user?.id) return;
    const user = sessionResult.user as { id: string; role?: string | null };
    request.user = { uid: user.id };
    // Also populated for plugins/rbac.ts + plugins/rate-limit.ts + plugins/cache.ts
    // (ported from Sagar's parallel B10 work), which read `request.authUser`/
    // `request.actor` rather than `request.user`/`request.authContext`.
    request.authUser = { id: user.id, platformRole: user.role ?? 'guest' };

    const organizationId = request.headers['x-organization-id'];
    // Matches `opaqueIdSchema` (packages/contracts). This hook is a global
    // `onRequest` — it runs before any route's `validateV2` preHandler, so an
    // unvalidated header reaches the repository layer first. A malformed id
    // (e.g. containing `/`) is a valid Firestore *path separator*, so
    // `getMember` → `.doc(organizationId)` throws instead of returning null —
    // an unhandled 500 for what should be a 422. Reject the shape here too,
    // before it ever reaches storage; the route's own schema still produces
    // the real 422 the client sees.
    if (
      typeof organizationId !== 'string' ||
      organizationId.length === 0 ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(organizationId)
    ) {
      return;
    }

    const member = await organizations
      .getMember(organizationId, user.id)
      .catch((error: unknown) => {
        fastify.log.warn({ err: error, organizationId }, 'organization membership lookup failed');
        return null;
      });
    if (!member) return;
    request.authContext = {
      activeMembership: {
        organizationId,
        role: member.role,
        capabilities: member.capabilities,
      },
    };
    request.actor = {
      userId: user.id,
      organizationId,
      role: member.role,
      capabilities: member.capabilities,
      platformRole: user.role ?? 'guest',
    };
  });
});

declare module 'fastify' {
  interface FastifyRequest {
    user?: { uid: string } | null;
    authContext?: {
      activeMembership?: {
        organizationId: string;
        role: OrganizationRole;
        capabilities: Capability[];
      };
    } | null;
    /** Populated alongside `user`/`authContext` — see the onRequest hook above. */
    authUser?: { id: string; platformRole: string };
    actor?: {
      userId: string;
      organizationId: string;
      role: OrganizationRole;
      capabilities: readonly Capability[];
      platformRole: string;
    };
  }
}
