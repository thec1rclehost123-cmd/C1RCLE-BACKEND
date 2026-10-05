import type { EntityId } from '../../domain/identity.js';
import type { GuestProfile } from '../../domain/models/guest-profile.js';
import type { GuestProfileRepository } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

/**
 * One doc per session user id in its own `v2_guest_profiles` collection per
 * this repo's `v2_`-prefix convention — fully replaced on each save, no
 * optimistic-lock version (a `PUT` with the same body converges, so retries
 * are safe without `compareAndSet`).
 */
const GUEST_PROFILE_COLLECTION = 'v2_guest_profiles';

export class FirestoreGuestProfileRepository implements GuestProfileRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(GUEST_PROFILE_COLLECTION);
  }

  async getByUserId(userId: EntityId): Promise<GuestProfile | null> {
    const data = (await this.collection.doc(userId).get()).data();
    return data ? toGuestProfile(data) : null;
  }

  async save(profile: GuestProfile): Promise<void> {
    await this.collection.doc(profile.userId).set(toDoc(profile));
  }
}

function toDoc(profile: GuestProfile): DocumentData {
  return {
    userId: profile.userId,
    displayName: profile.displayName,
    dateOfBirth: profile.dateOfBirth,
    city: profile.city,
    tastes: profile.tastes,
    intents: profile.intents,
    version: profile.version,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function toGuestProfile(data: DocumentData): GuestProfile {
  return {
    userId: data.userId as string,
    displayName: data.displayName as string,
    dateOfBirth: data.dateOfBirth as string,
    city: data.city as string,
    tastes: data.tastes as string[],
    intents: data.intents as string[],
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
