import { createHash } from 'node:crypto';

import { NotFoundError } from '../../domain/errors.js';
import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import {
  createWaitlistEntry,
  offerWaitlistEntry,
  acceptWaitlistOffer,
  expireWaitlistOffer,
  cancelWaitlistEntry,
} from '../../domain/models/waitlist-entry.js';

import { outboxDocument } from './firestore-outbox-store.js';
import { paginateUnordered } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { WaitlistEntry } from '../../domain/models/waitlist-entry.js';
import type { PaginationQuery, WaitlistRepository } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const ENTRIES = 'v2_waitlist_entries';
const SEQUENCES = 'v2_waitlist_sequences';
const ACTIVE_KEYS = 'v2_waitlist_active_keys';

export class FirestoreWaitlistRepository implements WaitlistRepository {
  constructor(private readonly db: Firestore) {}

  async join(input: {
    id: EntityId;
    eventId: EntityId;
    organizationId: EntityId;
    tierId: EntityId;
    userId: EntityId;
    accessGrantId?: EntityId | null;
    eligibilityAttested?: boolean;
    now: Date;
  }) {
    const keyId = digest(`${input.eventId}:${input.tierId}:${input.userId}`);
    const keyRef = this.db.collection(ACTIVE_KEYS).doc(keyId);
    const counterRef = this.db
      .collection(SEQUENCES)
      .doc(digest(`${input.eventId}:${input.tierId}`));
    const entryRef = this.db.collection(ENTRIES).doc(input.id);
    return this.db.runTransaction(async (tx) => {
      const [keySnap, counterSnap] = await Promise.all([tx.get(keyRef), tx.get(counterRef)]);
      const key = keySnap.data();
      if (key && (key.status === 'waiting' || key.status === 'offered')) {
        const existingRef = this.db.collection(ENTRIES).doc(String(key.entryId));
        const existingSnap = await tx.get(existingRef);
        const existingData = existingSnap.data();
        if (existingSnap.exists && existingData)
          return { entry: toEntry(existingData), created: false };
      }
      const sequence = Number(counterSnap.data()?.sequence ?? 0) + 1;
      const entry = createWaitlistEntry({ ...input, sequence });
      tx.create(entryRef, entry);
      tx.set(counterRef, { eventId: input.eventId, tierId: input.tierId, sequence });
      tx.set(keyRef, {
        entryId: entry.id,
        status: 'waiting',
        eventId: input.eventId,
        tierId: input.tierId,
        userId: input.userId,
      });
      const event = domainEvent({
        id: deterministicDomainEventId('waitlist.joined', entry.id),
        type: 'waitlist.joined',
        aggregateId: entry.id,
        organizationId: entry.organizationId,
        actorId: input.userId,
        occurredAt: input.now.getTime(),
        payload: {
          entryId: entry.id,
          eventId: entry.eventId,
          tierId: entry.tierId,
          sequence: entry.sequence,
        },
      });
      tx.create(this.db.collection('v2_outbox').doc(event.id), outboxDocument(event));
      return { entry, created: true };
    });
  }

  async getById(id: EntityId): Promise<WaitlistEntry | null> {
    const snap = await this.db.collection(ENTRIES).doc(id).get();
    const data = snap.data();
    return snap.exists && data ? toEntry(data) : null;
  }

  async listByUser(userId: EntityId, query: PaginationQuery) {
    return paginateUnordered(
      this.db.collection(ENTRIES).where('userId', '==', userId),
      query,
      toEntry,
    );
  }

  async listByEventTier(eventId: EntityId, tierId: EntityId, query: PaginationQuery) {
    const limit = Math.min(Math.max(query.limit, 1), 100);
    let queue = this.db
      .collection(ENTRIES)
      .where('eventId', '==', eventId)
      .where('tierId', '==', tierId)
      .orderBy('sequence', 'asc');
    if (query.cursor) {
      const after = Number.parseInt(query.cursor, 10);
      if (Number.isSafeInteger(after) && after > 0) queue = queue.startAfter(after);
    }
    const [snapshot, count] = await Promise.all([
      queue.limit(limit + 1).get(),
      this.db
        .collection(ENTRIES)
        .where('eventId', '==', eventId)
        .where('tierId', '==', tierId)
        .count()
        .get(),
    ]);
    const docs = snapshot.docs.slice(0, limit);
    const items = docs.map((doc) => toEntry(doc.data()));
    const last = items.at(-1);
    return {
      items,
      total: count.data().count,
      nextCursor: snapshot.docs.length > limit && last ? String(last.sequence) : null,
    };
  }

  async getNextWaiting(eventId: EntityId, tierId: EntityId): Promise<WaitlistEntry | null> {
    const snapshot = await this.db
      .collection(ENTRIES)
      .where('eventId', '==', eventId)
      .where('tierId', '==', tierId)
      .where('status', '==', 'waiting')
      .orderBy('sequence', 'asc')
      .limit(1)
      .get();
    const first = snapshot.docs[0];
    return first ? toEntry(first.data()) : null;
  }

  async offerNext(input: {
    eventId: EntityId;
    tierId: EntityId;
    actorId: EntityId;
    reservationId: EntityId;
    expiresAt: string;
    now: Date;
  }) {
    const collection = this.db.collection(ENTRIES);
    const replayQuery = collection.where('offerReservationId', '==', input.reservationId).limit(1);
    const queueQuery = collection
      .where('eventId', '==', input.eventId)
      .where('tierId', '==', input.tierId)
      .where('status', '==', 'waiting')
      .orderBy('sequence', 'asc')
      .limit(1);
    return this.db.runTransaction(async (tx) => {
      const replaySnap = await tx.get(replayQuery);
      if (!replaySnap.empty) {
        const data = replaySnap.docs[0]?.data();
        return data ? toEntry(data) : null;
      }
      const queueSnap = await tx.get(queueQuery);
      const queued = queueSnap.docs[0];
      if (!queued) return null;
      const entry = toEntry(queued.data());
      const offered = offerWaitlistEntry(entry, input);
      tx.set(queued.ref, offered);
      tx.set(
        this.db
          .collection(ACTIVE_KEYS)
          .doc(digest(`${entry.eventId}:${entry.tierId}:${entry.userId}`)),
        {
          entryId: entry.id,
          status: 'offered',
          eventId: entry.eventId,
          tierId: entry.tierId,
          userId: entry.userId,
        },
      );
      const event = domainEvent({
        id: deterministicDomainEventId('waitlist.offered', offered.id, input.reservationId),
        type: 'waitlist.offered',
        aggregateId: offered.id,
        organizationId: offered.organizationId,
        actorId: input.actorId,
        occurredAt: input.now.getTime(),
        payload: {
          entryId: offered.id,
          eventId: offered.eventId,
          tierId: offered.tierId,
          reservationId: input.reservationId,
          expiresAt: offered.offerExpiresAt ?? input.expiresAt,
        },
      });
      tx.create(this.db.collection('v2_outbox').doc(event.id), outboxDocument(event));
      return offered;
    });
  }

  async acceptOffer(input: { entryId: EntityId; userId: EntityId; now: Date }) {
    return this.updateEntry(
      input.entryId,
      (entry) => acceptWaitlistOffer(entry, input),
      'accepted',
      input.userId,
    );
  }

  async expireOffer(input: { entryId: EntityId; now: Date }) {
    return this.updateEntry(
      input.entryId,
      (entry) => expireWaitlistOffer(entry, input.now),
      'expired',
    );
  }

  async listExpiredOffers(now: Date, limit = 100) {
    const boundedLimit = Math.max(1, Math.min(500, limit));
    // An accepted offer is still just a short-lived checkout reservation. If
    // its holder never completes checkout, the worker must release it just as
    // it would an unaccepted offer. Keep the two equality queries so both
    // use the existing status/expiry composite index.
    const snapshots = await Promise.all(
      (['offered', 'accepted'] as const).map((status) =>
        this.db
          .collection(ENTRIES)
          .where('status', '==', status)
          .where('offerExpiresAt', '<=', now.toISOString())
          .orderBy('offerExpiresAt', 'asc')
          .limit(boundedLimit)
          .get(),
      ),
    );
    return snapshots
      .flatMap((snapshot) => snapshot.docs.map((document) => toEntry(document.data())))
      .sort(
        (left, right) =>
          (left.offerExpiresAt ?? '').localeCompare(right.offerExpiresAt ?? '') ||
          left.id.localeCompare(right.id),
      )
      .slice(0, boundedLimit);
  }

  async cancel(input: { entryId: EntityId; userId: EntityId; now: Date }) {
    return this.updateEntry(
      input.entryId,
      (entry) => cancelWaitlistEntry(entry, input),
      'cancelled',
      input.userId,
    );
  }

  private async updateEntry(
    entryId: EntityId,
    transition: (entry: WaitlistEntry) => WaitlistEntry,
    status: string,
    userId?: EntityId,
  ) {
    const ref = this.db.collection(ENTRIES).doc(entryId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!snap.exists || !data) throw new NotFoundError('waitlist_entry', entryId);
      const entry = toEntry(data);
      if (entry.status === status) {
        if (userId !== undefined && entry.userId !== userId)
          throw new NotFoundError('waitlist_entry', entryId);
        return entry;
      }
      const updated = transition(entry);
      tx.set(ref, updated);
      tx.set(
        this.db
          .collection(ACTIVE_KEYS)
          .doc(digest(`${entry.eventId}:${entry.tierId}:${entry.userId}`)),
        {
          entryId: entry.id,
          status: updated.status,
          eventId: entry.eventId,
          tierId: entry.tierId,
          userId: entry.userId,
        },
      );
      const event = waitlistTransitionEvent(updated, userId ?? 'system:waitlist-expiry', status);
      if (event) {
        tx.create(this.db.collection('v2_outbox').doc(event.id), outboxDocument(event));
      }
      return updated;
    });
  }
}

function waitlistTransitionEvent(entry: WaitlistEntry, actorId: EntityId, status: string) {
  const common = {
    aggregateId: entry.id,
    organizationId: entry.organizationId,
    actorId,
    occurredAt: Date.parse(entry.updatedAt),
  };
  if (status === 'accepted' && entry.offerReservationId && entry.offerExpiresAt) {
    return domainEvent({
      ...common,
      id: deterministicDomainEventId('waitlist.accepted', entry.id),
      type: 'waitlist.accepted',
      payload: {
        entryId: entry.id,
        eventId: entry.eventId,
        tierId: entry.tierId,
        reservationId: entry.offerReservationId,
        expiresAt: entry.offerExpiresAt,
      },
    });
  }
  if (status === 'expired') {
    return domainEvent({
      ...common,
      id: deterministicDomainEventId('waitlist.expired', entry.id),
      type: 'waitlist.expired',
      payload: {
        entryId: entry.id,
        eventId: entry.eventId,
        tierId: entry.tierId,
        reservationId: entry.offerReservationId,
      },
    });
  }
  if (status === 'cancelled') {
    return domainEvent({
      ...common,
      id: deterministicDomainEventId('waitlist.cancelled', entry.id),
      type: 'waitlist.cancelled',
      payload: { entryId: entry.id, eventId: entry.eventId, tierId: entry.tierId },
    });
  }
  return null;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toEntry(data: DocumentData): WaitlistEntry {
  return data as WaitlistEntry;
}
