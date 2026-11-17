import type { StaffRotationStore } from '../../domain/ports/staff-credentials.js';
import type { Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_staff_credentials';

/**
 * Firestore adapter for `StaffRotationStore` (B12): first-login rotation
 * flags keyed by Better Auth user id. A missing document means no rotation
 * is owed — flags are only ever written, never pre-seeded.
 */
export class FirestoreStaffRotationStore implements StaffRotationStore {
  constructor(private readonly db: Firestore) {}

  async setRequired(
    userId: string,
    required: boolean,
    options?: { expiresAt?: Date },
  ): Promise<void> {
    await this.db
      .collection(COLLECTION)
      .doc(userId)
      .set(
        {
          mustChangePassword: required,
          // A new credential carries its own expiry; rotating (required: false)
          // or issuing without one clears any previous expiry so an old date
          // can never lock out a freshly issued or rotated account.
          temporaryPasswordExpiresAt:
            required && options?.expiresAt ? options.expiresAt.toISOString() : null,
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
  }

  async isExpired(userId: string, now: Date): Promise<boolean> {
    const snap = await this.db.collection(COLLECTION).doc(userId).get();
    if (!snap.exists) return false;
    const data = snap.data();
    if (data?.mustChangePassword !== true) return false;
    const expiresAt: unknown = data.temporaryPasswordExpiresAt;
    if (typeof expiresAt !== 'string') return false;
    const at = Date.parse(expiresAt);
    return Number.isFinite(at) && now.getTime() >= at;
  }

  async isRequired(userId: string): Promise<boolean> {
    const snap = await this.db.collection(COLLECTION).doc(userId).get();
    if (!snap.exists) return false;
    return snap.data()?.mustChangePassword === true;
  }
}
