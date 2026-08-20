import { VersionConflictError } from '../../domain/errors.js';
import { createDoorSale } from '../../domain/models/door-sale.js';

import type { EntityId } from '../../domain/identity.js';
import type { DoorSale, DoorSaleCreateInput, DoorSaleCategory, DoorSaleStatus, DoorSalePaymentMode } from '../../domain/models/door-sale.js';
import type {
  DoorSaleRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';

function casSet<T extends { id: EntityId; version: number }>(
  map: Map<EntityId, T>,
  entity: T,
): void {
  const existing = map.get(entity.id);
  if (existing && existing.version !== entity.version - 1) {
    throw new VersionConflictError(entity.version - 1, existing.version);
  }
  map.set(entity.id, entity);
}

function serializeSlice<T>(all: T[], query: any): any {
  const { cursor, limit } = query;
  const start = cursor ? all.findIndex((item: any) => item.id === cursor) + 1 : 0;
  const end = Math.min(start + limit, all.length);
  const items = all.slice(start, end);
  const nextCursor = end < all.length && items.length > 0 ? (items[items.length - 1] as any).id : null;
  return { items, total: all.length, nextCursor };
}

export class MemoryDoorSaleRepository implements DoorSaleRepository {
  sales = new Map<EntityId, any>();
  byIdempotencyKey = new Map<string, EntityId>();

  async create(input: DoorSaleCreateInput): Promise<any> {
    // Check for existing sale with same idempotency key
    if (input.idempotencyKey) {
      const existingId = this.byIdempotencyKey.get(input.idempotencyKey);
      if (existingId) {
        const existing = this.sales.get(existingId);
        if (existing) return existing;
      }
    }
    const sale = createDoorSale(input);
    casSet(this.sales, sale);
    if (sale.idempotencyKey) {
      this.byIdempotencyKey.set(sale.idempotencyKey, sale.id);
    }
    return sale;
  }

  async findById(id: EntityId): Promise<any | null> {
    return this.sales.get(id) ?? null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<any | null> {
    const id = this.byIdempotencyKey.get(idempotencyKey);
    if (!id) return null;
    return this.sales.get(id) ?? null;
  }

  async findByEvent(eventId: EntityId, input: PaginationQuery): Promise<Page<any>> {
    const all = [...this.sales.values()].filter((s) => s.eventId === eventId);
    return serializeSlice(all, input);
  }

  async findByOrganization(organizationId: EntityId, input: PaginationQuery): Promise<Page<any>> {
    const all = [...this.sales.values()].filter((s) => s.organizationId === organizationId);
    return serializeSlice(all, input);
  }

  async findByVenue(venueId: EntityId, input: PaginationQuery): Promise<Page<any>> {
    const all = [...this.sales.values()].filter((s) => s.venueId === venueId);
    return serializeSlice(all, input);
  }

  async findByCategory(category: DoorSaleCategory, input: PaginationQuery): Promise<Page<any>> {
    const all = [...this.sales.values()].filter((s) => s.category === category);
    return serializeSlice(all, input);
  }

  async findByCreator(createdBy: EntityId, input: PaginationQuery): Promise<Page<any>> {
    const all = [...this.sales.values()].filter((s) => s.createdBy === createdBy);
    return serializeSlice(all, input);
  }

  async updateStatus(id: EntityId, status: DoorSaleStatus): Promise<any | null> {
    const sale = this.sales.get(id);
    if (!sale) return null;
    const updated = { ...sale, status, version: sale.version + 1, updatedAt: new Date().toISOString() };
    this.sales.set(id, updated);
    return updated;
  }

  async voidSale(id: EntityId, voidedBy: EntityId, reason: string): Promise<any | null> {
    const sale = this.sales.get(id);
    if (!sale) return null;
    const updated = { ...sale, status: 'voided', voidedAt: new Date().toISOString(), voidedBy, voidReason: reason, version: sale.version + 1, updatedAt: new Date().toISOString() };
    this.sales.set(id, updated);
    return updated;
  }

  async refundSale(id: EntityId, refundedBy: EntityId, amountPaise: number): Promise<any | null> {
    const sale = this.sales.get(id);
    if (!sale) return null;
    const updated = { ...sale, status: 'refunded', refundedAmountPaise: amountPaise, refundedAt: new Date().toISOString(), refundedBy, version: sale.version + 1, updatedAt: new Date().toISOString() };
    this.sales.set(id, updated);
    return updated;
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
    const all = [...this.sales.values()].filter((s) => s.eventId === eventId);
    const byPaymentMode: Record<string, { count: number; revenue: number }> = {};
    for (const s of all) {
      const key = s.paymentMode;
      if (!byPaymentMode[key]) byPaymentMode[key] = { count: 0, revenue: 0 };
      byPaymentMode[key].count++;
      byPaymentMode[key].revenue += s.amountPaise;
    }
    return {
      totalSales: all.length,
      totalRevenue: all.reduce((sum, s) => sum + s.amountPaise, 0),
      walkinCount: all.filter((s) => s.category === 'walkin').length,
      dineinCount: all.filter((s) => s.category === 'dinein').length,
      walkinRevenue: all.filter((s) => s.category === 'walkin').reduce((sum, s) => sum + s.amountPaise, 0),
      dineinRevenue: all.filter((s) => s.category === 'dinein').reduce((sum, s) => sum + s.amountPaise, 0),
      byPaymentMode,
    };
  }

  async getOrganizationStats(organizationId: EntityId, from: Date, to: Date): Promise<{
    totalSales: number;
    totalRevenue: number;
    byCategory: Record<string, { count: number; revenue: number }>;
    byPaymentMode: Record<string, { count: number; revenue: number }>;
  }> {
    const all = [...this.sales.values()].filter(
      (s) => s.organizationId === organizationId && new Date(s.createdAt) >= from && new Date(s.createdAt) <= to,
    );
    const byCategory: Record<string, { count: number; revenue: number }> = {};
    const byPaymentMode: Record<string, { count: number; revenue: number }> = {};
    for (const s of all) {
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
      totalSales: all.length,
      totalRevenue: all.reduce((sum, s) => sum + s.amountPaise, 0),
      byCategory,
      byPaymentMode,
    };
  }
}