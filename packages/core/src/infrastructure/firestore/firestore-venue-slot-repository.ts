import type { EntityId } from '../../domain/identity.js';
import type { VenueSlot } from '../../domain/models/venue.js';
import type { VenueSlotRepository, TxContext } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_venue_slots';

/**
 * Firestore adapter for `VenueSlotRepository` (B12). Slots per venue are a
 * small, bounded set, so the `from`/`to` window is filtered in application
 * code after a single equality query — avoids requiring a composite Firestore
 * index for what would otherwise be an equality+range query.
 */
export class FirestoreVenueSlotRepository implements VenueSlotRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async listSlots(venueId: EntityId, from: string, to: string): Promise<VenueSlot[]> {
    const snap = await this.collection.where('venueId', '==', venueId).get();
    return snap.docs
      .map((doc) => toVenueSlot(doc.data()))
      .filter((slot) => slot.startTime >= from && slot.startTime <= to);
  }

  async saveSlots(slots: VenueSlot[], _tx?: TxContext | null): Promise<void> {
    const batch = this.db.batch();
    for (const slot of slots) {
      batch.set(this.collection.doc(slot.id), toDoc(slot));
    }
    await batch.commit();
  }
}

function toDoc(slot: VenueSlot): DocumentData {
  return { ...slot };
}

function toVenueSlot(data: DocumentData): VenueSlot {
  return {
    id: data.id as string,
    venueId: data.venueId as string,
    label: data.label as string,
    startTime: data.startTime as string,
    endTime: data.endTime as string,
    recurring: data.recurring as boolean,
    status: data.status as VenueSlot['status'],
    capacityFor: (data.capacityFor as number | null) ?? null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
