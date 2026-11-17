import {
  InvalidOperationError,
  SlotRequestNotFoundError,
  VersionConflictError,
} from '../../domain/errors.js';
import { setVenueSlotRequestState } from '../../domain/models/venue.js';

import { compareAndSet } from './compare-and-set.js';
import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { SlotRequest, VenueSlot } from '../../domain/models/venue.js';
import type {
  AcceptedEventBundle,
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

  async createForOpenSlot(request: SlotRequest, implicitSlot?: VenueSlot): Promise<void> {
    const slotId = request.slotId;
    if (!slotId) throw new InvalidOperationError('A Venue slot is required for this request');
    const slotRef = this.db.collection('v2_venue_slots').doc(slotId);
    const requestRef = this.collection.doc(request.id);
    await this.db.runTransaction(async (tx) => {
      const [slotSnap, requestSnap] = await Promise.all([tx.get(slotRef), tx.get(requestRef)]);
      const slotData = slotSnap.data() ?? implicitSlot;
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
      {
        const existing = await tx.get(
          this.db.collection('v2_venue_slots').where('venueId', '==', request.venueId).limit(2001),
        );
        if (existing.size > 2000)
          throw new InvalidOperationError('Venue calendar requires review before booking');
        const events = await tx.get(
          this.db.collection('v2_events').where('venueId', '==', request.venueId).limit(1001),
        );
        if (
          events.size > 1000 ||
          events.docs.some((doc) => {
            const event = doc.data();
            return (
              event.id !== request.eventId &&
              event.status !== 'cancelled' &&
              event.status !== 'archived' &&
              Date.parse(event.startAt as string) < Date.parse(slot.endTime) &&
              Date.parse((event.endAt ?? event.startAt) as string) > Date.parse(slot.startTime)
            );
          })
        )
          throw new InvalidOperationError('The selected time overlaps a Venue event');
        if (
          existing.docs.some((doc) => {
            const existingSlot = toVenueSlot(doc.data());
            return (
              existingSlot.id !== slot.id &&
              existingSlot.status !== 'open' &&
              existingSlot.status !== 'cancelled' &&
              Date.parse(existingSlot.startTime) < Date.parse(slot.endTime) &&
              Date.parse(existingSlot.endTime) > Date.parse(slot.startTime)
            );
          })
        )
          throw new InvalidOperationError('The selected time is no longer available');
      }

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
        throw new InvalidOperationError(
          'An accepted Host slot request is required to create this event',
        );
      }
      if (request.eventId && request.eventId !== eventId) {
        throw new InvalidOperationError('This accepted slot already has an event');
      }
      const slotRef = this.db.collection('v2_venue_slots').doc(request.slotId);
      const slotSnap = await tx.get(slotRef);
      const slotData = slotSnap.data();
      if (
        !slotData ||
        slotData.venueId !== request.venueId ||
        slotData.status !== 'booked' ||
        slotData.slotRequestId !== request.id ||
        slotData.requestingHostId !== hostId
      ) {
        throw new InvalidOperationError(
          'The accepted Venue slot is no longer reserved for this Host',
        );
      }
      if (request.eventId === eventId) return request;
      const updated = {
        ...request,
        eventId,
        version: request.version + 1,
        updatedAt: new Date().toISOString(),
      };
      tx.set(requestRef, toDoc(updated));
      return updated;
    });
  }

  async commitAcceptedEventBundle(bundle: AcceptedEventBundle): Promise<SlotRequest> {
    const { previousRequest, acceptedRequest, bookedSlot, event, tiers, promos, assignments } =
      bundle;
    const requestRef = this.collection.doc(previousRequest.id);
    const slotRef = this.db.collection('v2_venue_slots').doc(bookedSlot.id);
    const eventRef = this.db.collection('v2_events').doc(event.id);
    const tierRefs = tiers.map((item) => this.db.collection('v2_event_catalog_tiers').doc(item.id));
    const promoRefs = promos.map((item) =>
      this.db.collection('v2_event_catalog_promos').doc(item.id),
    );
    const assignmentRefs = assignments.map((item) =>
      this.db.collection('v2_event_catalog_promoter_assignments').doc(item.id),
    );
    return this.db.runTransaction(async (tx) => {
      const refs = [requestRef, slotRef, eventRef, ...tierRefs, ...promoRefs, ...assignmentRefs];
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
      const [requestSnap, slotSnap, eventSnap, ...catalogSnaps] = snaps;
      const stored = requestSnap?.data();
      const slotData = slotSnap?.data();
      if (!stored || !slotData || !requestSnap?.exists || !slotSnap?.exists) {
        throw new SlotRequestNotFoundError(previousRequest.id);
      }
      const current = toSlotRequest(stored);
      const currentSlot = toVenueSlot(slotData);
      const [venueEvents, venueSlots] = await Promise.all([
        tx.get(this.db.collection('v2_events').where('venueId', '==', current.venueId).limit(1001)),
        tx.get(
          this.db.collection('v2_venue_slots').where('venueId', '==', current.venueId).limit(2001),
        ),
      ]);
      if (venueEvents.size > 1000 || venueSlots.size > 2000) {
        throw new InvalidOperationError('Venue calendar requires review before event acceptance');
      }
      const start = Date.parse(event.startAt);
      const end = Date.parse(event.endAt ?? '');
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        start < Date.parse(currentSlot.startTime) ||
        end > Date.parse(currentSlot.endTime)
      )
        throw new InvalidOperationError(
          'Event date and time must fit within the accepted Venue slot',
        );
      if (
        venueEvents.docs.some((doc) => {
          const existing = doc.data();
          return (
            existing.id !== event.id &&
            existing.status !== 'cancelled' &&
            existing.status !== 'archived' &&
            Date.parse(existing.startAt as string) < end &&
            Date.parse((existing.endAt ?? existing.startAt) as string) > start
          );
        })
      )
        throw new InvalidOperationError('The accepted Venue slot conflicts with another event');
      if (
        venueSlots.docs.some((doc) => {
          const existing = toVenueSlot(doc.data());
          return (
            existing.id !== currentSlot.id &&
            existing.status !== 'open' &&
            existing.status !== 'cancelled' &&
            Date.parse(existing.startTime) < end &&
            Date.parse(existing.endTime) > start
          );
        })
      )
        throw new InvalidOperationError('The accepted event conflicts with a Venue calendar slot');
      const replay = current.status === 'accepted' && current.eventId === event.id;
      if (
        !replay &&
        (current.version !== previousRequest.version || current.status !== 'pending')
      ) {
        throw new VersionConflictError(previousRequest.version, current.version);
      }
      if (
        current.hostId !== previousRequest.hostId ||
        current.venueId !== previousRequest.venueId ||
        current.slotId !== bookedSlot.id ||
        currentSlot.venueId !== current.venueId ||
        currentSlot.slotRequestId !== current.id ||
        currentSlot.requestingHostId !== current.hostId ||
        (currentSlot.status !== 'pending' && !(replay && currentSlot.status === 'booked'))
      ) {
        throw new InvalidOperationError('The Venue slot is no longer held by this request');
      }
      if (eventSnap?.exists && !replay) {
        throw new InvalidOperationError('The proposed event identifier is already in use');
      }
      const storedEvent = eventSnap?.data();
      if (
        storedEvent &&
        (storedEvent.organizationId !== current.hostId || storedEvent.venueId !== current.venueId)
      ) {
        throw new InvalidOperationError('The accepted event identifier belongs to another record');
      }
      const expectedCatalogCount = tierRefs.length + promoRefs.length + assignmentRefs.length;
      const storedCatalog = catalogSnaps.slice(0, expectedCatalogCount);
      if (
        replay &&
        storedCatalog.some((snap) => snap.exists && snap.data()?.eventId !== event.id)
      ) {
        throw new InvalidOperationError(
          'An accepted event catalog identifier belongs to another event',
        );
      }
      if (!replay && storedCatalog.some((snap) => snap.exists)) {
        throw new InvalidOperationError('A proposed event catalog identifier is already in use');
      }
      if (
        replay &&
        currentSlot.status === 'booked' &&
        eventSnap?.exists &&
        storedEvent?.status === 'published' &&
        storedCatalog.every((snap) => snap.exists)
      )
        return current;

      // Firestore commits this request/slot/event/catalog batch all-or-nothing.
      // On replay of a legacy accepted-but-incomplete record, only missing docs
      // are filled; IDs and the request's accepted state must still match.
      tx.set(requestRef, toDoc(acceptedRequest));
      tx.set(slotRef, toVenueSlotDoc(bookedSlot));
      if (!eventSnap?.exists) tx.create(eventRef, { ...event });
      else if (replay && storedEvent?.status !== 'published') tx.set(eventRef, { ...event });
      let cursor = 0;
      for (let index = 0; index < tiers.length; index += 1) {
        const tier = tiers[index];
        const tierRef = tierRefs[index];
        const snap = storedCatalog[cursor++];
        if (!tier || !tierRef || !snap) {
          throw new InvalidOperationError('The accepted event tier bundle is incomplete');
        }
        if (!snap?.exists) {
          const data = { ...tier } as Record<string, unknown>;
          if (tier.accessType === 'RSVP') {
            delete data.priceInPaise;
            delete data.pricingPhases;
            delete data.doorPriceInPaise;
            delete data.commissionEligible;
          }
          tx.create(tierRef, data);
        }
      }
      for (let index = 0; index < promos.length; index += 1) {
        const promo = promos[index];
        const promoRef = promoRefs[index];
        const snap = storedCatalog[cursor++];
        if (!promo || !promoRef || !snap) {
          throw new InvalidOperationError('The accepted event promotion bundle is incomplete');
        }
        if (!snap.exists) tx.create(promoRef, { ...promo });
      }
      for (let index = 0; index < assignments.length; index += 1) {
        const assignment = assignments[index];
        const assignmentRef = assignmentRefs[index];
        const snap = storedCatalog[cursor++];
        if (!assignment || !assignmentRef || !snap) {
          throw new InvalidOperationError('The accepted event promoter bundle is incomplete');
        }
        if (!snap.exists) tx.create(assignmentRef, { ...assignment });
      }
      return acceptedRequest;
    });
  }
}

function toDoc(request: SlotRequest): DocumentData {
  return { ...request };
}

function toVenueSlotDoc(slot: VenueSlot): DocumentData {
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
    rejectionReason: (data.rejectionReason as string | null) ?? null,
    eventDraft: data.eventDraft as SlotRequest['eventDraft'],
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
