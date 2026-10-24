import { InvalidOperationError, SlotRequestNotFoundError, VersionConflictError } from '../../domain/errors.js';
import { setVenueSlotRequestState } from '../../domain/models/venue.js';

import { compareAndSet } from './compare-and-set.js';
import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { SlotRequest } from '../../domain/models/venue.js';
import type {
  SlotRequestRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_slot_requests';

/** Firestore adapter for `SlotRequestRepository` (B12). */
export class FirestoreSlotRequestRepository implements SlotRequestRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async getById(slotRequestId: EntityId): Promise<SlotRequest | null> {
    const snap = await this.collection.doc(slotRequestId).get();
    const data = snap.data();
    return data ? toSlotRequest(data) : null;
  }

  async listByVenue(venueId: EntityId, query: PaginationQuery): Promise<Page<SlotRequest>> {
    const base = this.collection.where('venueId', '==', venueId);
    return paginateQuery(base, query, toSlotRequest);
  }

  async listByHost(hostId: EntityId, query: PaginationQuery): Promise<Page<SlotRequest>> {
    const base = this.collection.where('hostId', '==', hostId);
    return paginateQuery(base, query, toSlotRequest);
  }

  async save(request: SlotRequest, _tx?: TxContext | null): Promise<void> {
    // Compare-and-set: a write of version N must find N-1 (see compare-and-set.ts).
    await compareAndSet(this.db, this.collection, request, toDoc);
  }

  async createForOpenSlot(request: SlotRequest): Promise<void> {
    const slotId = request.slotId;
    if (!slotId) throw new InvalidOperationError('A Venue slot is required for this request');
    const slotRef = this.db.collection('v2_venue_slots').doc(slotId);
    const requestRef = this.collection.doc(request.id);
    await this.db.runTransaction(async (tx) => {
      const [slotSnap, requestSnap] = await Promise.all([tx.get(slotRef), tx.get(requestRef)]);
      const slotData = slotSnap.data();
      if (!slotData || slotData.venueId !== request.venueId) {
        throw new SlotRequestNotFoundError(request.id);
      }
      if (requestSnap.exists) throw new InvalidOperationError('Slot request already exists');
      if (slotData.status !== 'open') {
        throw new InvalidOperationError('This Venue slot is no longer open for requests');
      }
      const visibleTo = slotData.visibleToHostIds as string[] | null | undefined;
      if (visibleTo && !visibleTo.includes(request.hostId)) {
        throw new InvalidOperationError('This Venue slot is not available to this Host');
      }
      const slot = toVenueSlot(slotData);
      const pending = setVenueSlotRequestState(
        slot,
        'pending',
        request.id,
        request.hostId,
        new Date(request.createdAt),
      );
      tx.set(slotRef, toVenueSlotDoc(pending));
      tx.set(requestRef, toDoc(request));
    });
  }

  async transitionForSlot(previous: SlotRequest, updated: SlotRequest): Promise<void> {
    const slotId = previous.slotId;
    if (!slotId) throw new InvalidOperationError('This request is not linked to a Venue slot');
    const requestRef = this.collection.doc(previous.id);
    const slotRef = this.db.collection('v2_venue_slots').doc(slotId);
    await this.db.runTransaction(async (tx) => {
      const [requestSnap, slotSnap] = await Promise.all([tx.get(requestRef), tx.get(slotRef)]);
      const storedRequest = requestSnap.data();
      const slotData = slotSnap.data();
      if (!storedRequest || !slotData || slotData.venueId !== previous.venueId) {
        throw new SlotRequestNotFoundError(previous.id);
      }
      const storedVersion = Number(storedRequest.version ?? 0);
      if (storedVersion !== previous.version) {
        throw new VersionConflictError(previous.version, storedVersion);
      }
      const slot = toVenueSlot(slotData);
      if (slot.slotRequestId !== previous.id || slot.requestingHostId !== previous.hostId) {
        throw new InvalidOperationError('The Venue slot is no longer held by this request');
      }
      const nextSlotStatus =
        updated.status === 'accepted'
          ? 'booked'
          : updated.status === 'cancelled' && previous.status === 'accepted'
            ? 'cancelled'
            : 'open';
      const nextSlot = setVenueSlotRequestState(
        slot,
        nextSlotStatus,
        nextSlotStatus === 'open' ? null : previous.id,
        nextSlotStatus === 'open' ? null : previous.hostId,
        new Date(updated.updatedAt),
      );
      tx.set(requestRef, toDoc(updated));
      tx.set(slotRef, toVenueSlotDoc(nextSlot));
    });
  }

  async claimAcceptedSlotEvent(
    slotRequestId: EntityId,
    hostId: EntityId,
    eventId: EntityId,
  ): Promise<SlotRequest> {
    const requestRef = this.collection.doc(slotRequestId);
    return this.db.runTransaction(async (tx) => {
      const requestSnap = await tx.get(requestRef);
      const data = requestSnap.data();
      if (!data) throw new SlotRequestNotFoundError(slotRequestId);
      const request = toSlotRequest(data);
      if (request.hostId !== hostId || request.status !== 'accepted' || !request.slotId) {
        throw new InvalidOperationError('An accepted Host slot request is required to create this event');
      }
      if (request.eventId && request.eventId !== eventId) {
        throw new InvalidOperationError('This accepted slot already has an event');
      }
      const slotRef = this.db.collection('v2_venue_slots').doc(request.slotId);
      const slotSnap = await tx.get(slotRef);
      const slotData = slotSnap.data();
      if (!slotData || slotData.venueId !== request.venueId || slotData.status !== 'booked' || slotData.slotRequestId !== request.id || slotData.requestingHostId !== hostId) {
        throw new InvalidOperationError('The accepted Venue slot is no longer reserved for this Host');
      }
      if (request.eventId === eventId) return request;
      const updated = { ...request, eventId, version: request.version + 1, updatedAt: new Date().toISOString() };
      tx.set(requestRef, toDoc(updated));
      return updated;
    });
  }
}

function toDoc(request: SlotRequest): DocumentData {
  return { ...request };
}

function toVenueSlotDoc(slot: import('../../domain/models/venue.js').VenueSlot): DocumentData {
  return { ...slot };
}

function toVenueSlot(data: DocumentData): import('../../domain/models/venue.js').VenueSlot {
  return {
    id: data.id as string,
    venueId: data.venueId as string,
    label: data.label as string,
    startTime: data.startTime as string,
    endTime: data.endTime as string,
    recurring: data.recurring as boolean,
    status: data.status as import('../../domain/models/venue.js').VenueSlot['status'],
    capacityFor: (data.capacityFor as number | null) ?? null,
    timezone: (data.timezone as string | null) ?? null,
    notes: (data.notes as string | null) ?? null,
    visibleToHostIds: (data.visibleToHostIds as string[] | null) ?? null,
    slotRequestId: (data.slotRequestId as string | null) ?? null,
    requestingHostId: (data.requestingHostId as string | null) ?? null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}

function toSlotRequest(data: DocumentData): SlotRequest {
  return {
    id: data.id as string,
    venueId: data.venueId as string,
    slotId: (data.slotId as string | null) ?? null,
    slotStartTime: (data.slotStartTime as string | null) ?? null,
    slotEndTime: (data.slotEndTime as string | null) ?? null,
    timezone: (data.timezone as string | null) ?? null,
    eventId: (data.eventId as string | null) ?? null,
    hostId: data.hostId as string,
    status: data.status as SlotRequest['status'],
    message: data.message as string | undefined,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
