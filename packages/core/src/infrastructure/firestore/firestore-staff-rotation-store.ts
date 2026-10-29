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

  async setRequired(userId: string, required: boolean): Promise<void> {
    await this.db.collection(COLLECTION).doc(userId).set(
      {
        mustChangePassword: required,
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
  }

  async isRequired(userId: string): Promise<boolean> {
    const snap = await this.db.collection(COLLECTION).doc(userId).get();
    if (!snap.exists) return false;
    return snap.data()?.mustChangePassword === true;
  }
}
