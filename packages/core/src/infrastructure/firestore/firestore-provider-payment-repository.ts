import { VersionConflictError } from '../../domain/errors.js';

import { paginateQuery } from './pagination.js';

import type { ProviderDispute, ProviderPayment } from '../../domain/models/provider-payment.js';
import type {
  ProviderPaymentRepository,
  Page,
  PaginationQuery,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const PROVIDER_PAYMENT_COLLECTION = 'v2_provider_payments';

export class FirestoreProviderPaymentRepository implements ProviderPaymentRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(PROVIDER_PAYMENT_COLLECTION);
  }

  async findByPaymentId(paymentId: string): Promise<ProviderPayment | null> {
    const snap = await this.collection.doc(paymentId).get();
    const data = snap.data();
    return data ? toProviderPayment(data) : null;
  }

  async findByProviderOrderId(providerOrderId: string): Promise<ProviderPayment | null> {
    const snap = await this.collection
      .where('providerOrderId', '==', providerOrderId)
      .limit(1)
      .get();
    const data = snap.docs[0]?.data();
    return data ? toProviderPayment(data) : null;
  }

  async listAll(query: PaginationQuery): Promise<Page<ProviderPayment>> {
    return paginateQuery(this.collection.orderBy('createdAt', 'desc'), query, toProviderPayment);
  }

  async save(record: ProviderPayment): Promise<void> {
    const ref = this.collection.doc(record.id);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      const expected = record.version - 1;
      const current = data ? (data.version as number) : 0;
      if (current !== expected) throw new VersionConflictError(expected, current);
      tx.set(ref, toDoc(record));
    });
  }
}

function toDoc(record: ProviderPayment): DocumentData {
  return {
    id: record.id,
    provider: record.provider,
    providerOrderId: record.providerOrderId,
    orderId: record.orderId,
    processingState: record.processingState,
    currency: record.currency,
    capturedPaise: record.capturedPaise,
    feePaise: record.feePaise,
    taxOnFeePaise: record.taxOnFeePaise,
    capturedAt: record.capturedAt,
    refunds: record.refunds,
    disputes: record.disputes,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toProviderPayment(data: DocumentData): ProviderPayment {
  return {
    id: data.id as string,
    provider: 'razorpay',
    providerOrderId: (data.providerOrderId as string | null | undefined) ?? null,
    orderId: (data.orderId as string | null | undefined) ?? null,
    processingState:
      (data.processingState as ProviderPayment['processingState'] | undefined) ??
      (data.orderId ? 'fulfilled' : data.providerOrderId ? 'processing' : 'requires_support'),
    currency: data.currency as string,
    capturedPaise: data.capturedPaise as number,
    feePaise: data.feePaise as number,
    taxOnFeePaise: data.taxOnFeePaise as number,
    capturedAt: (data.capturedAt as string | null | undefined) ?? null,
    refunds: (data.refunds as Record<string, number> | undefined) ?? {},
    disputes: (data.disputes as Record<string, ProviderDispute> | undefined) ?? {},
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
