import type { StaffUserDirectory } from '../../domain/ports/staff-credentials.js';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * Firestore adapter for `StaffUserDirectory` (B12): finds the Better Auth
 * user id behind an address in the gateway-configured users collection.
 * Matches the exact and the normalized form so one address can never fork
 * into two logins.
 */
export class FirestoreStaffUserDirectory implements StaffUserDirectory {
  constructor(
    private readonly db: Firestore,
    private readonly usersCollection: string,
  ) {}

  async findUserIdByEmail(email: string): Promise<string | null> {
    const normalized = email.trim().toLowerCase();
    // Dedupe: an already-lowercase address would otherwise send the same value
    // twice in the `in` filter.
    const candidates = Array.from(new Set([email.trim(), normalized]));
    const snap = await this.db
      .collection(this.usersCollection)
      .where('email', 'in', candidates)
      .limit(1)
      .get();
    if (snap.empty) return null;
    return snap.docs[0]?.id ?? null;
  }

  async getEmailById(userId: string): Promise<string | null> {
    const snap = await this.db.collection(this.usersCollection).doc(userId).get();
    if (!snap.exists) return null;
    const data = snap.data();
    return (data?.email as string) ?? null;
  }
}
