import type { EntityId } from '../../domain/identity.js';
import type { StaffUserDirectory } from '../../domain/ports/staff-credentials.js';
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

export class FirestoreUserDirectory implements UserDirectoryPort, StaffUserDirectory {
  readonly name = 'firestore-auth-users';

  constructor(
    private readonly db: Firestore,
    private readonly usersCollection: string = AUTH_USERS_COLLECTION,
  ) {}

  async getEmailById(userId: EntityId): Promise<string | null> {
    const data = (await this.db.collection(this.usersCollection).doc(userId).get()).data();
    const email = data?.email as unknown;
    return typeof email === 'string' && email.length > 0 ? email : null;
  }

  async findUserIdByEmail(email: string): Promise<string | null> {
    const normalized = email.trim().toLowerCase();
    const candidates = Array.from(new Set([email.trim(), normalized]));
    const snap = await this.db
      .collection(this.usersCollection)
      .where('email', 'in', candidates)
      .limit(1)
      .get();
    if (snap.empty) return null;
    return snap.docs[0]?.id ?? null;
  }
}
