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
import { buildV2ErrorResponse } from '@c1rcle/contracts';
import { FirestoreUserBanRepository } from '@c1rcle/core/infrastructure/firestore';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { bearer } from 'better-auth/plugins';
import { firestoreAdapter } from 'better-auth-firestore';
import fp from 'fastify-plugin';

import type {
  Capability,
  EmailSender,
  OrganizationRepository,
  OrganizationRole,
  StaffRotationStore,
  UserBanRepository,
} from '@c1rcle/core/domain';
import type { Firestore } from '@c1rcle/core/infrastructure';

import { getGoogleAuthConfig } from '../config/google-auth.js';
import {
  allowedBrowserOrigins,
  getBetterAuthTrustedOrigins,
  type GatewayConfig,
} from '../config/index.js';

import type { FastifyInstance } from 'fastify';

export type BetterAuthInstance = ReturnType<typeof buildBetterAuth>;

/**
 * Builds the Better Auth instance. Only called when `STORAGE_DRIVER=firestore`.
 *
 * ─── Confirmed cookie / session defaults (better-auth 1.x, verified 2026-08-27) ──
 * This config is deliberately minimal and leans on Better Auth's defaults; the
 * frontend↔gateway auth design (spec §13.4 / D-024) depends on them, so they are
 * recorded here rather than re-specified:
 *   - session cookie: `httpOnly: true`, `sameSite: 'lax'`, `path: '/'`, no `Domain`
 *     (host-only). The Next.js BFF re-scopes it to the frontend origin.
 *   - `secure`: driven by `advanced.useSecureCookies` below — `true` only when
 *     `NODE_ENV === 'production'` (prod-gated, so `http://localhost` dev still works).
 *   - session lifetime: `expiresIn` 7 days, `updateAge` 1 day — a read inside the
 *     updateAge window extends expiry in place; the token string is NOT rotated
 *     (see `routes/v2/auth/index.ts` `/refresh`, and phase-00 Session Log).
 *   - `trustedOrigins`: the union of the explicit environment-driven origins
 *     (`BETTER_AUTH_TRUSTED_ORIGINS` or `ALLOWED_ORIGINS`) and the CORS
 *     allow-list (`allowedBrowserOrigins` — `CORS_ALLOWED_ORIGINS`, or the 3
 *     frontend dev origins when unset outside production), so a browser origin
 *     allowed by CORS is never rejected by Better Auth (or vice versa).
 * No behaviour change is intended here; adjust the explicit options below only if
 * a test proves a default diverges from the above.
 */
export function buildBetterAuth(gw: GatewayConfig, db: Firestore, emailSender: EmailSender) {
  const userBans = new FirestoreUserBanRepository(db);
  const google = getGoogleAuthConfig();
  if (google && !getBetterAuthTrustedOrigins(gw).includes(new URL(google.redirectURI).origin))
    throw new Error('Google callback origin must be a configured trusted frontend origin.');
  return betterAuth({
    socialProviders: google
      ? {
          google: {
            ...google,
            mapProfileToUser: (profile) => {
              if (!profile.email_verified)
                throw new APIError('FORBIDDEN', { message: 'Verified email required' });
              return { role: 'guest' };
            },
          },
        }
      : {},
    account: {
      accountLinking: {
        enabled: true,
        allowDifferentEmails: false,
        requireLocalEmailVerified: true,
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const ban = await userBans.getByUserId(session.userId).catch(() => {
              throw new APIError('SERVICE_UNAVAILABLE', { message: 'Account access unavailable' });
            });
            if (ban?.isBanned)
              throw new APIError('FORBIDDEN', { message: 'Account access denied' });
          },
        },
      },
    },
    secret: gw.BETTER_AUTH_SECRET,
    baseURL: gw.BETTER_AUTH_URL,
    basePath: '/api/v2/auth',
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
      // Resetting a compromised password must also invalidate existing cookies/bearers.
      revokeSessionsOnPasswordReset: true,
      // Wires the forgot-password flow. Without this callback Better Auth throws
      // RESET_PASSWORD_DISABLED on `requestPasswordReset` (verified against
      // better-auth 1.6.26: `dist/api/routes/password.mjs`). The callback
      // receives `{user, url, token}`; the url embeds the single-use token and
      // expires in 1h. In prod (RESEND_API_KEY set) the link emails the user;
      // otherwise the LoggingEmailSender prints it to the log for dev/ops.
      sendResetPassword: ({ user, url }) => emailSender.sendPasswordResetEmail(user.email, url),
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
    trustedOrigins: [
      ...new Set([...getBetterAuthTrustedOrigins(gw), ...allowedBrowserOrigins(gw)]),
    ],
    plugins: [bearer()],
  });
}

export interface AuthContextPluginOptions {
  auth: BetterAuthInstance | null;
  organizations: OrganizationRepository;
  rotationStore: StaffRotationStore;
  userBans: UserBanRepository;
}

/**
 * Auth paths that stay usable while an account owes its first-login password
 * rotation. Everything else 403s with `password_change_required` until the
 * rotation completes — a temporary credential must not unlock the app.
 */
const PASSWORD_ROTATION_ALLOWLIST = [
  '/api/v2/auth/login',
  '/api/v2/auth/signup',
  '/api/v2/auth/partner/signup',
  '/api/v2/auth/refresh',
  '/api/v2/auth/session',
  '/api/v2/auth/logout',
  '/api/v2/auth/change-password',
  '/api/v2/auth/otp/send',
  '/api/v2/auth/otp/verify',
];

function isPasswordRotationExempt(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return PASSWORD_ROTATION_ALLOWLIST.some(
    (allowed) => path === allowed || path.startsWith(`${allowed}/`),
  );
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
  const { auth, organizations, rotationStore, userBans } = options;
  if (!auth) return;

  fastify.addHook('onRequest', async (request, reply) => {
    const sessionResult = await auth.api
      .getSession({ headers: toWebHeaders(request.headers) })
      .catch(() => null);
    if (!sessionResult?.user?.id) return;
    const user = sessionResult.user as { id: string; role?: string | null };
    const route = request.routeOptions.url;
    const isLogout = request.method === 'POST' && route === '/api/v2/auth/logout';
    if (!isLogout) {
      let banned: boolean;
      try {
        banned = (await userBans.getByUserId(user.id))?.isBanned === true;
      } catch {
        return reply.status(503).send(
          buildV2ErrorResponse({
            status: 503,
            message: 'Account access unavailable',
            requestId: request.id,
          }),
        );
      }
      if (banned)
        return reply.status(403).send(
          buildV2ErrorResponse({
            status: 403,
            code: 'forbidden',
            message: 'Account access denied',
            requestId: request.id,
          }),
        );
    }
    // An unavailable security flag must not make a temporary credential unrestricted.
    let mustChangePassword = false;
    if (!isLogout) {
      try {
        mustChangePassword = await rotationStore.isRequired(user.id);
      } catch {
        return reply.status(503).send(
          buildV2ErrorResponse({
            status: 503,
            message: 'Account access unavailable',
            requestId: request.id,
          }),
        );
      }
    }
    request.user = { uid: user.id };
    // Also populated for plugins/rbac.ts + plugins/rate-limit.ts + plugins/cache.ts
    // (ported from Sagar's parallel B10 work), which read `request.authUser`/
    // `request.actor` rather than `request.user`/`request.authContext`.
    request.authUser = { id: user.id, platformRole: user.role ?? 'guest', mustChangePassword };

    // Session-only actor: authenticated, not yet scoped to any organization.
    // Routes that need an org still fail closed — the ABAC path check in
    // plugins/rbac.ts and the services' own `requireOrgAccess` both reject the
    // empty `organizationId`. The membership block below upgrades this to a
    // full actor when an `X-Organization-Id` resolves. Without it, every
    // "signed in but not yet in an org" route (GET/POST /organizations,
    // onboarding, accept-invitation) 401s on the firestore driver, because
    // `buildActorContext` treats a missing actor as "no session".
    request.actor = {
      userId: user.id,
      organizationId: '',
      role: 'member',
      capabilities: [],
      platformRole: user.role ?? 'guest',
    };

    // Sign-out and independently authorized platform-admin recovery do not
    // require access to the selected organization. Account bans still apply.
    if (isLogout || route?.startsWith('/api/v2/admin/')) return;
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

    let organization;
    try {
      organization = await organizations.getById(organizationId);
    } catch {
      return reply.status(503).send(
        buildV2ErrorResponse({
          status: 503,
          message: 'Organization access unavailable',
          requestId: request.id,
        }),
      );
    }
    const member = organization?.members.find((member) => member.userId === user.id);
    if (!member) return;
    if (organization?.status !== 'active') {
      return reply.status(403).send(
        buildV2ErrorResponse({
          status: 403,
          code: 'forbidden',
          message: 'Organization access denied',
          requestId: request.id,
        }),
      );
    }
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

  // First-login rotation enforcement: an account on a temporary credential
  // may only rotate it, refresh its session, or sign out — every other
  // authenticated route 403s until then. Runs as `preHandler` (not
  // `onRequest`) so exempt auth paths are matched against the routed URL.
  // The `details.passwordChangeRequired` marker lets clients tell this 403
  // apart from a permission denial without parsing the message.
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.authUser?.mustChangePassword) return;
    if (isPasswordRotationExempt(request.url)) return;
    return reply.status(403).send(
      buildV2ErrorResponse({
        status: 403,
        code: 'forbidden',
        message: 'Change your temporary password before continuing.',
        requestId: request.id,
        details: { passwordChangeRequired: true },
      }),
    );
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
    authUser?: { id: string; platformRole: string; mustChangePassword?: boolean };
    actor?: {
      userId: string;
      organizationId: string;
      role: OrganizationRole;
      capabilities: readonly Capability[];
      platformRole: string;
    };
  }
}
