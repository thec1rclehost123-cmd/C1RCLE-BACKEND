import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  LedgerEntry,
  LedgerEntryStatus,
  LedgerEntryType,
} from '../../domain/models/ledger.js';
import type { LedgerRepository, Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const LEDGER_COLLECTION = 'v2_partner_ledger';
const IDEMPOTENCY_COLLECTION = 'v2_partner_ledger_idempotency';

export class FirestoreLedgerRepository implements LedgerRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(LEDGER_COLLECTION);
  }

  async createBatch(entries: LedgerEntry[]): Promise<LedgerEntry[]> {
    return this.db.runTransaction(async (tx) => {
      const created: LedgerEntry[] = [];
      for (const entry of entries) {
        const idemRef = this.db.collection(IDEMPOTENCY_COLLECTION).doc(entry.idempotencyKey);
        const idemSnap = await tx.get(idemRef);
        if (idemSnap.exists) continue;
        tx.set(this.collection.doc(entry.id), toDoc(entry));
        tx.set(idemRef, { entryId: entry.id });
        created.push(entry);
      }
      return created.length > 0 ? created : entries;
    });
  }

  async findByOrder(orderId: EntityId): Promise<LedgerEntry[]> {
    const snap = await this.collection.where('orderId', '==', orderId).get();
    return snap.docs.map((doc) => toEntry(doc.data()));
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<LedgerEntry | null> {
    const idDoc = await this.db.collection(IDEMPOTENCY_COLLECTION).doc(idempotencyKey).get();
    const idData = idDoc.data();
    if (!idData) return null;
    const snap = await this.collection.doc(idData.entryId as string).get();
    const data = snap.data();
    return data ? toEntry(data) : null;
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<LedgerEntry>> {
    const base = this.collection
      .where('organizationId', '==', organizationId)
      .orderBy('createdAt', 'desc');
    return paginateQuery(base, query, toEntry);
  }

  async sumByOrganizationAndType(
    organizationId: EntityId,
  ): Promise<Record<LedgerEntryType, { pending: number; settled: number; paidOut: number }>> {
    const snap = await this.collection.where('organizationId', '==', organizationId).get();
    const result: Record<LedgerEntryType, { pending: number; settled: number; paidOut: number }> = {
      ticket_revenue: { pending: 0, settled: 0, paidOut: 0 },
      platform_fee: { pending: 0, settled: 0, paidOut: 0 },
      venue_share: { pending: 0, settled: 0, paidOut: 0 },
      host_payout: { pending: 0, settled: 0, paidOut: 0 },
      promoter_commission: { pending: 0, settled: 0, paidOut: 0 },
      refund: { pending: 0, settled: 0, paidOut: 0 },
    };
    for (const doc of snap.docs) {
      const entry = toEntry(doc.data());
      const bucket = result[entry.entryType];
      if (entry.status === 'pending') bucket.pending += entry.amount;
      else if (entry.status === 'settled') bucket.settled += entry.amount;
      else bucket.paidOut += entry.amount;
    }
    return result;
  }
}

function toDoc(entry: LedgerEntry): DocumentData {
  return {
    id: entry.id,
    organizationId: entry.organizationId,
    orderId: entry.orderId,
    eventId: entry.eventId,
    entryType: entry.entryType,
    amount: entry.amount,
    status: entry.status,
    idempotencyKey: entry.idempotencyKey,
    version: entry.version,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function toEntry(data: DocumentData): LedgerEntry {
  return {
    id: data.id as string,
    organizationId: data.organizationId as string,
    orderId: data.orderId as string,
    eventId: data.eventId as string,
    entryType: data.entryType as LedgerEntryType,
    amount: data.amount as number,
    status: data.status as LedgerEntryStatus,
    idempotencyKey: data.idempotencyKey as string,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
