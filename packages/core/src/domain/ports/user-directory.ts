import type { EntityId } from '../identity.js';

/**
 * ─── UserDirectoryPort (Phase 2 gap-closure) ─────────────────────────────────
 *
 * Resolves an auth user id (the opaque `userId` every `ActorContext` carries)
 * to that person's email, for the one case a service needs to reach a user
 * outside their own session: notifying an applicant their onboarding request
 * needs changes. There is no `UserRepository` in this codebase — identity is
 * owned by Better Auth (`v2_auth_users`, see `apps/api-gateway/src/plugins/
 * auth.ts`), not by a domain aggregate — so this is a thin read-only seam
 * onto that store, not a new identity concept. Mirrors `ObjectStoragePort`'s
 * shape: a name for support-history visibility, one real adapter
 * (`FirestoreUserDirectory`), and a safe default for the memory/test driver.
 */
export interface UserDirectoryPort {
  readonly name: string;
  /** `null` when the user cannot be found or has no email on file. */
  getEmailById(userId: EntityId): Promise<string | null>;
  /** Finds the user id for an email address, or null when no login exists. */
  findUserIdByEmail(email: string): Promise<string | null>;
}

/**
 * Dev/test default: there is no Better Auth user store on `STORAGE_DRIVER=memory`
 * (auth is bypassed entirely — see `plugins/auth.ts`'s header comment), so
 * there is nothing to resolve. Callers must treat `null` as "could not notify
 * this user", never as an error.
 */
export class NullUserDirectory implements UserDirectoryPort {
  readonly name = 'null';

  async getEmailById(): Promise<string | null> {
    return null;
  }

  async findUserIdByEmail(): Promise<string | null> {
    return null;
  }
}
