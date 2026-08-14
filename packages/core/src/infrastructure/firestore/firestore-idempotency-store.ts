import type { IdempotencyRecord, IdempotencyStore } from '../../domain/ports/idempotency.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_idempotency_records';

/**
 * ─── Durable idempotency store (T09) ─────────────────────────────────────────
 *
 * The memory store loses every record on restart and shares nothing between
 * instances, which means replay protection silently stops working exactly when
 * it matters most: a deploy mid-retry, or a second instance behind a load
 * balancer. A client's "retry" then becomes a second charge, a second event, a
 * second invitation.
 *
 * `claim` is the whole contract, and it must be **atomic**: of N concurrent
 * callers with the same key, exactly one may win. Firestore's
 * `create()` fails if the document already exists, which gives us that for
 * free — no read-then-write race.
 */
export class FirestoreIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  /**
   * Returns `null` when the caller won the slot, or the existing record when
   * someone else already holds it (so the service can replay or reject).
   */
  async claim(
    key: string,
    requestHash: string,
    expiresAt: number,
  ): Promise<IdempotencyRecord | null> {
    const ref = this.collection.doc(encodeKey(key));

    const existing = await ref.get();
    const stored = existing.data();
    if (stored) {
      const record = toRecord(stored);
      // An expired record is not a claim: take the slot over rather than
      // blocking a legitimate new command forever.
      if (record.expiresAt > Date.now()) return record;
      await ref.delete().catch(() => undefined);
    }

    try {
      // `create` throws if the document exists — the atomic step that decides
      // the winner. A loser lands in the catch and re-reads what won.
      await ref.create({
        key,
        requestHash,
        status: 'IN_PROGRESS',
        statusCode: null,
        responseBody: null,
        expiresAt,
      });
      return null;
    } catch {
      const raced = await ref.get();
      const data = raced.data();
      // If it vanished again between the failure and this read, treat the slot
      // as ours: the alternative is failing a command for no reason.
      return data ? toRecord(data) : null;
    }
  }

  async complete(key: string, statusCode: number, responseBody: unknown): Promise<void> {
    await this.collection.doc(encodeKey(key)).set(
      {
        status: 'COMPLETED',
        statusCode,
        // Firestore rejects `undefined`; a body-less 204 stores as null.
        responseBody: responseBody ?? null,
      },
      { merge: true },
    );
  }

  async release(key: string): Promise<void> {
    await this.collection.doc(encodeKey(key)).delete();
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const snap = await this.collection.doc(encodeKey(key)).get();
    const data = snap.data();
    if (!data) return null;
    const record = toRecord(data);
    return record.expiresAt > Date.now() ? record : null;
  }
}

/**
 * Keys are `${actorId}:${commandName}:${idempotencyKey}` and the client half is
 * arbitrary, so `/` would split it into a Firestore subcollection path.
 */
function encodeKey(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

function toRecord(data: DocumentData): IdempotencyRecord {
  return {
    key: data.key as string,
    requestHash: data.requestHash as string,
    status: data.status as IdempotencyRecord['status'],
    statusCode: (data.statusCode ?? null) as number | null,
    responseBody: data.responseBody ?? null,
    expiresAt: data.expiresAt as number,
  };
}
