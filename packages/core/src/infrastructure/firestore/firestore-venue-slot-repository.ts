import { assertSlotRangeFree, doSlotRangesOverlap } from '../../domain/models/venue.js';

import type { EntityId } from '../../domain/identity.js';
import type { VenueSlot } from '../../domain/models/venue.js';
import type { VenueSlotRepository, TxContext } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_venue_slots';

/**
 * Hard cap on how many of a venue's slot documents a single read may pull.
 * Slots per venue are a small, bounded set by design, but a venue that
 * accumulates thousands of past `cancelled` tombstones must never turn a
 * calendar read into an unbounded scan — `.limit()` caps memory and read cost,
 * and the overlap/window filtering below runs over this capped set.
 */
const MAX_SLOTS_READ = 2000;

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
    const snap = await this.collection.where('venueId', '==', venueId).limit(MAX_SLOTS_READ).get();
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

  async getSlotById(slotId: EntityId): Promise<VenueSlot | null> {
    const doc = await this.collection.doc(slotId).get();
    if (!doc.exists) return null;
    const data = doc.data();
    return data ? toVenueSlot(data) : null;
  }

  async listOverlappingSlots(
    venueId: EntityId,
    startTime: string,
    endTime: string,
  ): Promise<VenueSlot[]> {
    const snap = await this.collection.where('venueId', '==', venueId).limit(MAX_SLOTS_READ).get();
    return snap.docs
      .map((doc) => toVenueSlot(doc.data()))
      .filter((slot) => doSlotRangesOverlap(slot.startTime, slot.endTime, startTime, endTime));
  }

  /**
   * Atomic block creation: the overlap guard and the insert share one
   * Firestore transaction, closing the read-check-write TOCTOU where two
   * concurrent blocks could both pass the guard and both land. The check
   * reuses the domain `assertSlotRangeFree` so the failure shape is identical
   * to the old non-atomic path (400 `InvalidOperationError`).
   */
  async createBlockIfFree(block: VenueSlot): Promise<VenueSlot> {
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(
        this.collection.where('venueId', '==', block.venueId).limit(MAX_SLOTS_READ),
      );
      const existing = snap.docs.map((doc) => toVenueSlot(doc.data()));
      assertSlotRangeFree(existing, block.startTime, block.endTime);
      tx.set(this.collection.doc(block.id), toDoc(block));
    });
    return block;
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
