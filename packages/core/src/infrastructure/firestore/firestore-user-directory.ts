import type { EntityId } from '../../domain/identity.js';
import type { UserDirectoryPort } from '../../domain/ports/user-directory.js';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * ─── Firestore-backed user directory ─────────────────────────────────────────
 * Reads straight from Better Auth's own collection (`v2_auth_users`, see
 * `apps/api-gateway/src/plugins/auth.ts`'s `firestoreAdapter` collections
 * map) rather than a domain repository — there is no separate "user"
 * aggregate in `packages/core`; Better Auth owns this data. A read-only seam,
 * same Rule 3 `firebase-admin` exemption as every other file in this
 * directory.
 */
const AUTH_USERS_COLLECTION = 'v2_auth_users';

export class FirestoreUserDirectory implements UserDirectoryPort {
  readonly name = 'firestore-auth-users';

  constructor(private readonly db: Firestore) {}

  async getEmailById(userId: EntityId): Promise<string | null> {
    const data = (await this.db.collection(AUTH_USERS_COLLECTION).doc(userId).get()).data();
    const email = data?.email as unknown;
    return typeof email === 'string' && email.length > 0 ? email : null;
  }
}
