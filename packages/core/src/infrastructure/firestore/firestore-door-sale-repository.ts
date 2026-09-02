import { createDoorSale } from '../../domain/models/door-sale.js';

import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  DoorSale,
  DoorSaleCreateInput,
  DoorSaleCategory,
  DoorSalePaymentMode,
  DoorSaleStatus,
} from '../../domain/models/door-sale.js';
import type { DoorSaleRepository, Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_door_sales';
const IDEMPOTENCY_COLLECTION = 'v2_door_sale_idempotency';

export class FirestoreDoorSaleRepository implements DoorSaleRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  private get idempotencyCollection() {
    return this.db.collection(IDEMPOTENCY_COLLECTION);
  }

  /**
   * The port owns entity creation (`create(input): Promise<DoorSale>`), so the
   * adapter — not the caller — mints the id/version/timestamps via
   * `createDoorSale`. Previously this took an already-built `DoorSale` and
   * persisted it verbatim (only compiling because TS method parameters are
   * bivariant), so the same call returned a different id depending on which
   * adapter was wired, and a port-shaped call would have written `id:
   * undefined`. Matches `MemoryDoorSaleRepository.create` exactly.
   */
  async create(input: DoorSaleCreateInput): Promise<DoorSale> {
    const sale = createDoorSale(input);
    await this.collection.doc(sale.id).set(toDoc(sale));
    if (sale.idempotencyKey) {
      await this.idempotencyCollection.doc(sale.idempotencyKey).set({ saleId: sale.id });
    }
    return sale;
  }

  async findById(id: EntityId): Promise<DoorSale | null> {
    const snap = await this.collection.doc(id).get();
    const data = snap.data();
    return data ? toSale(data) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<DoorSale | null> {
    const idDoc = await this.idempotencyCollection.doc(idempotencyKey).get();
    const idData = idDoc.data();
    if (!idData) return null;
    const saleId = idData.saleId as string;
    const snap = await this.collection.doc(saleId).get();
    const data = snap.data();
    return data ? toSale(data) : null;
  }

  async findByEvent(eventId: EntityId, input: PaginationQuery): Promise<Page<DoorSale>> {
    const base = this.collection.where('eventId', '==', eventId).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toSale);
  }

  async findByOrganization(
    organizationId: EntityId,
    input: PaginationQuery,
  ): Promise<Page<DoorSale>> {
    const base = this.collection
      .where('organizationId', '==', organizationId)
      .orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toSale);
  }

  async findByVenue(venueId: EntityId, input: PaginationQuery): Promise<Page<DoorSale>> {
    const base = this.collection.where('venueId', '==', venueId).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toSale);
  }

  async findByCategory(
    category: DoorSaleCategory,
    input: PaginationQuery,
  ): Promise<Page<DoorSale>> {
    const base = this.collection.where('category', '==', category).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toSale);
  }

  async findByCreator(createdBy: EntityId, input: PaginationQuery): Promise<Page<DoorSale>> {
    const base = this.collection.where('createdBy', '==', createdBy).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toSale);
  }

  async updateStatus(id: EntityId, status: DoorSaleStatus): Promise<DoorSale | null> {
    const ref = this.collection.doc(id);
    await ref.update({ status, updatedAt: new Date().toISOString() });
    const snap = await ref.get();
    const data = snap.data();
    return data ? toSale(data) : null;
  }

  async voidSale(id: EntityId, voidedBy: EntityId, reason: string): Promise<DoorSale | null> {
    const ref = this.collection.doc(id);
    await ref.update({
      status: 'voided',
      voidedAt: new Date().toISOString(),
      voidedBy,
      voidReason: reason,
      updatedAt: new Date().toISOString(),
    });
    const snap = await ref.get();
    const data = snap.data();
    return data ? toSale(data) : null;
  }

  async refundSale(
    id: EntityId,
    refundedBy: EntityId,
    amountPaise: number,
  ): Promise<DoorSale | null> {
    const ref = this.collection.doc(id);
    await ref.update({
      status: 'refunded',
      refundedAmountPaise: amountPaise,
      refundedAt: new Date().toISOString(),
      refundedBy,
      updatedAt: new Date().toISOString(),
    });
    const snap = await ref.get();
    const data = snap.data();
    return data ? toSale(data) : null;
  }

  async getEventStats(eventId: EntityId): Promise<{
    totalSales: number;
    totalRevenue: number;
    walkinCount: number;
    dineinCount: number;
    walkinRevenue: number;
    dineinRevenue: number;
    byPaymentMode: Record<string, { count: number; revenue: number }>;
  }> {
    const snap = await this.collection.where('eventId', '==', eventId).get();
    const sales = snap.docs.map((doc) => toSale(doc.data()));
    const byPaymentMode: Record<string, { count: number; revenue: number }> = {};
    for (const s of sales) {
      const key = s.paymentMode;
      let entry = byPaymentMode[key];
      if (!entry) {
        entry = { count: 0, revenue: 0 };
        byPaymentMode[key] = entry;
      }
      entry.count++;
      entry.revenue += s.amountPaise;
    }
    return {
      totalSales: sales.length,
      totalRevenue: sales.reduce((sum, s) => sum + s.amountPaise, 0),
      walkinCount: sales.filter((s) => s.category === 'walkin').length,
      dineinCount: sales.filter((s) => s.category === 'dinein').length,
      walkinRevenue: sales
        .filter((s) => s.category === 'walkin')
        .reduce((sum, s) => sum + s.amountPaise, 0),
      dineinRevenue: sales
        .filter((s) => s.category === 'dinein')
        .reduce((sum, s) => sum + s.amountPaise, 0),
      byPaymentMode,
    };
  }

  async getOrganizationStats(
    organizationId: EntityId,
    from: Date,
    to: Date,
  ): Promise<{
    totalSales: number;
    totalRevenue: number;
    byCategory: Record<string, { count: number; revenue: number }>;
    byPaymentMode: Record<string, { count: number; revenue: number }>;
  }> {
    const snap = await this.collection
      .where('organizationId', '==', organizationId)
      .where('createdAt', '>=', from.toISOString())
      .where('createdAt', '<=', to.toISOString())
      .get();
    const sales = snap.docs.map((doc) => toSale(doc.data()));
    const byCategory: Record<string, { count: number; revenue: number }> = {};
    const byPaymentMode: Record<string, { count: number; revenue: number }> = {};
    for (const s of sales) {
      let catEntry = byCategory[s.category];
      if (!catEntry) {
        catEntry = { count: 0, revenue: 0 };
        byCategory[s.category] = catEntry;
      }
      catEntry.count++;
      catEntry.revenue += s.amountPaise;

      let payEntry = byPaymentMode[s.paymentMode];
      if (!payEntry) {
        payEntry = { count: 0, revenue: 0 };
        byPaymentMode[s.paymentMode] = payEntry;
      }
      payEntry.count++;
      payEntry.revenue += s.amountPaise;
    }
    return {
      totalSales: sales.length,
      totalRevenue: sales.reduce((sum, s) => sum + s.amountPaise, 0),
      byCategory,
      byPaymentMode,
    };
  }
}

function toDoc(sale: DoorSale): DocumentData {
  return {
    id: sale.id,
    eventId: sale.eventId,
    organizationId: sale.organizationId,
    venueId: sale.venueId,
    category: sale.category,
    guestName: sale.guestName,
    guestPhone: sale.guestPhone,
    guestAge: sale.guestAge,
    gender: sale.gender,
    contact: sale.contact,
    totalGuests: sale.totalGuests,
    tableNumber: sale.tableNumber,
    gate: sale.gate,
    paymentMode: sale.paymentMode,
    amountPaise: sale.amountPaise,
    paymentStatus: sale.paymentStatus,
    paymentRef: sale.paymentRef,
    createdBy: sale.createdBy,
    createdByName: sale.createdByName,
    status: sale.status,
    voidedAt: sale.voidedAt,
    voidedBy: sale.voidedBy,
    voidReason: sale.voidReason,
    refundedAmountPaise: sale.refundedAmountPaise,
    refundedAt: sale.refundedAt,
    refundedBy: sale.refundedBy,
    idempotencyKey: sale.idempotencyKey,
    version: sale.version,
    createdAt: sale.createdAt,
    updatedAt: sale.updatedAt,
  };
}

function toSale(data: DocumentData): DoorSale {
  return {
    id: data.id as string,
    eventId: data.eventId as string,
    organizationId: data.organizationId as string,
    venueId: data.venueId as string | null,
    category: data.category as DoorSaleCategory,
    guestName: data.guestName as string,
    guestPhone: data.guestPhone as string | null,
    guestAge: data.guestAge as number | null,
    gender: data.gender as string | null,
    contact: data.contact as string | null,
    totalGuests: data.totalGuests as number,
    tableNumber: data.tableNumber as string | null,
    gate: data.gate as string | null,
    paymentMode: data.paymentMode as DoorSalePaymentMode,
    amountPaise: data.amountPaise as number,
    paymentStatus: data.paymentStatus as DoorSale['paymentStatus'],
    paymentRef: data.paymentRef as string | null,
    createdBy: data.createdBy as string,
    createdByName: data.createdByName as string | null,
    status: data.status as DoorSaleStatus,
    voidedAt: data.voidedAt as string | null,
    voidedBy: data.voidedBy as string | null,
    voidReason: data.voidReason as string | null,
    refundedAmountPaise: data.refundedAmountPaise as number | null,
    refundedAt: data.refundedAt as string | null,
    refundedBy: data.refundedBy as string | null,
    idempotencyKey: data.idempotencyKey as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
