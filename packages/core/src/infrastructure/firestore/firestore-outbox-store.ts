import { OUTBOX_MAX_ATTEMPTS } from '../../domain/ports/outbox.js';

import type { DomainEvent } from '../../domain/events.js';
import type { EntityId } from '../../domain/identity.js';
import type { OutboxRecord, OutboxStore } from '../../domain/ports/outbox.js';
import type { DocumentData, Firestore, Transaction } from 'firebase-admin/firestore';

const OUTBOX_COLLECTION = 'v2_outbox';

export class FirestoreOutboxStore implements OutboxStore {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(OUTBOX_COLLECTION);
  }

  async append(event: DomainEvent): Promise<void> {
    const reference = this.collection.doc(event.id);
    await this.db.runTransaction(async (transaction) => {
      if ((await transaction.get(reference)).exists) return;
      transaction.create(reference, outboxDocument(event));
    });
  }

  async markProcessed(id: EntityId, processedAt: number, leaseToken?: string): Promise<void> {
    await this.updateIfPresent(id, (transaction, data) => {
      if (leaseToken && (data.status !== 'processing' || data.leaseToken !== leaseToken)) return;
      transaction.update(this.collection.doc(id), {
        status: 'processed',
        processedAt,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: processedAt,
        attempts: data.attempts,
      });
    });
  }

  async markFailed(id: EntityId, attempts: number, leaseToken?: string): Promise<void> {
    await this.updateIfPresent(id, (transaction, data) => {
      if (leaseToken && (data.status !== 'processing' || data.leaseToken !== leaseToken)) return;
      transaction.update(this.collection.doc(id), {
        status: 'failed',
        attempts,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: Date.now(),
      });
    });
  }

  async bumpAttempts(id: EntityId): Promise<number> {
    return this.db.runTransaction(async (transaction) => {
      const reference = this.collection.doc(id);
      const snapshot = await transaction.get(reference);
      const data = snapshot.data();
      if (!data) return 0;
      const attempts = (data.attempts as number) + 1;
      transaction.update(reference, {
        attempts,
        status: attempts >= OUTBOX_MAX_ATTEMPTS ? 'failed' : data.status,
        updatedAt: Date.now(),
      });
      return attempts;
    });
  }

  async scheduleRetry(
    id: EntityId,
    nextAttemptAt: number,
    error: string,
    leaseToken?: string,
  ): Promise<void> {
    await this.updateIfPresent(id, (transaction, data) => {
      if (leaseToken && (data.status !== 'processing' || data.leaseToken !== leaseToken)) return;
      transaction.update(this.collection.doc(id), {
        status: 'pending',
        nextAttemptAt,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: error,
        updatedAt: Date.now(),
      });
    });
  }

  async listPending(limit = 100): Promise<OutboxRecord[]> {
    const snapshot = await this.collection.where('status', '==', 'pending').limit(limit).get();
    const now = Date.now();
    return snapshot.docs
      .map((document) => toRecord(document.data()))
      .filter((record) => record.nextAttemptAt <= now);
  }

  async claimPending(input: {
    workerId: string;
    now: number;
    leaseMs: number;
    limit?: number;
    eventId?: EntityId;
  }): Promise<OutboxRecord[]> {
    return this.db.runTransaction(async (transaction) => {
      const limit = input.limit ?? 100;
      const records =
        input.eventId === undefined
          ? await Promise.all([
              transaction.get(
                this.collection
                  .where('status', '==', 'pending')
                  .where('nextAttemptAt', '<=', input.now)
                  .orderBy('nextAttemptAt', 'asc')
                  .limit(limit),
              ),
              transaction.get(
                this.collection
                  .where('status', '==', 'processing')
                  .where('leaseExpiresAt', '<=', input.now)
                  .orderBy('leaseExpiresAt', 'asc')
                  .limit(limit),
              ),
            ]).then(([pendingSnapshot, processingSnapshot]) => [
              ...pendingSnapshot.docs.map((document) => toRecord(document.data())),
              ...processingSnapshot.docs.map((document) => toRecord(document.data())),
            ])
          : await transaction
              .get(this.collection.doc(input.eventId))
              .then((snapshot) => (snapshot.exists ? [toRecord(snapshot.data() ?? {})] : []));
      const candidates = records
        .filter(
          (record) =>
            (input.eventId === undefined || record.id === input.eventId) &&
            record.attempts < OUTBOX_MAX_ATTEMPTS &&
            ((record.status === 'pending' && record.nextAttemptAt <= input.now) ||
              (record.status === 'processing' &&
                record.leaseExpiresAt !== null &&
                record.leaseExpiresAt <= input.now)),
        )
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(0, limit);

      for (const record of candidates) {
        const attempts = record.attempts + 1;
        const leaseToken = `${input.workerId}:${record.id}:${String(attempts)}:${String(input.now)}`;
        const claimed: OutboxRecord = {
          ...record,
          status: 'processing',
          attempts,
          leaseOwner: input.workerId,
          leaseToken,
          leaseExpiresAt: input.now + input.leaseMs,
          updatedAt: input.now,
        };
        transaction.update(this.collection.doc(record.id), toDoc(claimed));
      }
      return candidates.map((record) => {
        const attempts = record.attempts + 1;
        return {
          ...record,
          status: 'processing',
          attempts,
          leaseOwner: input.workerId,
          leaseToken: `${input.workerId}:${record.id}:${String(attempts)}:${String(input.now)}`,
          leaseExpiresAt: input.now + input.leaseMs,
          updatedAt: input.now,
        };
      });
    });
  }

  private async updateIfPresent(
    id: EntityId,
    update: (transaction: Transaction, data: OutboxRecord) => void,
  ): Promise<void> {
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(this.collection.doc(id));
      const data = snapshot.data();
      if (data) update(transaction, toRecord(data));
    });
  }
}

/** Shared serializer for domain transactions that atomically enqueue events. */
export function outboxDocument(event: DomainEvent): OutboxRecord {
  return {
    id: event.id,
    type: event.type,
    aggregateId: event.aggregateId,
    payload: event,
    status: 'pending',
    attempts: 0,
    createdAt: event.occurredAt,
    processedAt: null,
    nextAttemptAt: event.occurredAt,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastError: null,
    updatedAt: event.occurredAt,
  };
}

function toDoc(record: OutboxRecord): DocumentData {
  return { ...record };
}

function toRecord(data: DocumentData): OutboxRecord {
  return {
    id: data.id as string,
    type: data.type as string,
    aggregateId: data.aggregateId as string,
    payload: data.payload,
    status: data.status as OutboxRecord['status'],
    attempts: data.attempts as number,
    createdAt: data.createdAt as number,
    processedAt: (data.processedAt as number | null) ?? null,
    nextAttemptAt: data.nextAttemptAt as number,
    leaseOwner: (data.leaseOwner as string | null) ?? null,
    leaseToken: (data.leaseToken as string | null) ?? null,
    leaseExpiresAt: (data.leaseExpiresAt as number | null) ?? null,
    lastError: (data.lastError as string | null) ?? null,
    updatedAt: data.updatedAt as number,
  };
}
