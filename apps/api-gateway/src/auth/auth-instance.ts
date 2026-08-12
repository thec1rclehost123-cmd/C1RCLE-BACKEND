import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { bearer } from 'better-auth/plugins';

import type { GatewayConfig } from '../config/index.js';

/**
 * ─── Better Auth instance (B10 / D-001) ──────────────────────────────────────
 *
 * The backend owns the durable credential: an httpOnly session cookie Better
 * Auth sets and rotates. The client keeps the same token in memory only and
 * sends it as `Authorization: Bearer` — which is why the `bearer()` plugin is
 * enabled. Nothing is ever written to localStorage, so an injected script has
 * nothing to steal.
 *
 * Storage: the memory adapter, matching the rest of this slice. Sessions do
 * not survive a restart and are not shared between instances — B12 swaps this
 * one line for the durable adapter and nothing else changes.
 */

export interface AuthDatabase {
  user: Record<string, unknown>[];
  session: Record<string, unknown>[];
  account: Record<string, unknown>[];
  verification: Record<string, unknown>[];
}

export function createAuthDatabase(): AuthDatabase {
  return { user: [], session: [], account: [], verification: [] };
}

export type AuthInstance = ReturnType<typeof createAuth>;

export function createAuth(config: GatewayConfig, database: AuthDatabase = createAuthDatabase()) {
  return betterAuth({
    database: memoryAdapter(database as never),
    secret: config.AUTH_SECRET,
    baseURL: config.AUTH_BASE_URL,
    trustedOrigins: config.AUTH_TRUSTED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    emailAndPassword: { enabled: true },
    session: {
      expiresIn: config.AUTH_SESSION_TTL_SECONDS,
      // Rotate well before expiry so an active tab never falls off a cliff.
      updateAge: Math.floor(config.AUTH_SESSION_TTL_SECONDS / 7),
    },
    advanced: {
      // Secure cookies in production; plain http is only tolerable in dev.
      useSecureCookies: config.NODE_ENV === 'production',
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
      },
    },
    user: {
      additionalFields: {
        // The frontend's Role union. Backend is the authority on what it means.
        role: { type: 'string', defaultValue: 'partner', input: false },
      },
    },
    plugins: [bearer()],
  });
}
