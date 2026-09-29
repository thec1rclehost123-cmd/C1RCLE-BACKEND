import type { EntityId } from '../identity.js';

/**
 * ─── Platform user (Better Auth account) ─────────────────────────────────────
 * Admin directory view of an account on the platform. Minimal, READ-ONLY —
 * admin routes never mutate Better Auth users. Model mirrors the Better Auth
 * `user` document in the `v2_auth_users` collection (see
 * `apps/api-gateway/src/plugins/auth.ts`), with timestamps normalized to
 * epoch ms to stay on the wire contract.
 */
export interface PlatformUser {
  id: EntityId;
  email: string;
  name: string;
  image: string | null;
  emailVerified: boolean;
  /** Platform role (e.g. `partner`, `admin`, `guest`) — Better Auth additional field. */
  role: string | null;
  createdAt: number;
  updatedAt: number;
}
