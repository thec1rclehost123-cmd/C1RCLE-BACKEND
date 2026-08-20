import { VersionConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { ScanLedger, ScanLedgerStatus, ScanDenyReason } from '../../domain/models/scan-ledger.js';
import type {
  ScanLedgerRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';

/**
 * In-memory Scan Ledger repository for testing and development.
 */
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

function serializeSlice<T>(all: T[], query: PaginationQuery): Page<T> {
  const { cursor, limit } = query;
  const start = cursor ? all.findIndex((item: any) => item.id === cursor) + 1 : 0;
  const end = Math.min(start + limit, all.length);
  const items = all.slice(start, end);
  const nextCursor = end < all.length && items.length > 0 ? (items[items.length - 1] as any).id : null;
  return { items, total: all.length, nextCursor };
}

export class MemoryScanLedgerRepository implements ScanLedgerRepository {
  scans = new Map<EntityId, ScanLedger>();

  async create(scan: ScanLedger): Promise<ScanLedger> {
    casSet(this.scans, scan);
    return scan;
  }

  async findById(id: EntityId): Promise<ScanLedger | null> {
    return this.scans.get(id) ?? null;
  }

  async findByEventAndEntitlement(eventId: EntityId, entitlementId: EntityId): Promise<ScanLedger | null> {
    for (const scan of this.scans.values()) {
      if (scan.eventId === eventId && scan.entitlementId === entitlementId) {
        return scan;
      }
    }
    return null;
  }

  async findByEvent(eventId: EntityId, input: PaginationQuery): Promise<Page<ScanLedger>> {
    const all = [...this.scans.values()].filter((s) => s.eventId === eventId);
    return serializeSlice(all, input);
  }

  async findByOrganization(organizationId: EntityId, input: PaginationQuery): Promise<Page<ScanLedger>> {
    const all = [...this.scans.values()].filter((s) => s.organizationId === organizationId);
    return serializeSlice(all, input);
  }

  async findByDevice(deviceId: string, input: PaginationQuery): Promise<Page<ScanLedger>> {
    const all = [...this.scans.values()].filter((s) => s.deviceId === deviceId);
    return serializeSlice(all, input);
  }

  async findByOperator(operatorUid: string, input: PaginationQuery): Promise<Page<ScanLedger>> {
    const all = [...this.scans.values()].filter((s) => s.operatorUid === operatorUid);
    return serializeSlice(all, input);
  }

  async updateStatus(
    id: EntityId,
    status: ScanLedgerStatus,
    denyReason?: ScanDenyReason,
    denyMessage?: string,
  ): Promise<ScanLedger | null> {
    const scan = this.scans.get(id);
    if (!scan) return null;
    const updated = { ...scan, status, denyReason: denyReason ?? scan.denyReason, denyMessage: denyMessage ?? scan.denyMessage, version: scan.version + 1, updatedAt: new Date().toISOString() };
    this.scans.set(id, updated);
    return updated;
  }

  async markConsumed(id: EntityId): Promise<ScanLedger | null> {
    return this.updateStatus(id, 'consumed');
  }

  async markDenied(id: EntityId, reason: ScanDenyReason, message: string): Promise<ScanLedger | null> {
    return this.updateStatus(id, 'denied', reason, message);
  }

  async markCancelled(id: EntityId): Promise<ScanLedger | null> {
    return this.updateStatus(id, 'cancelled');
  }

  async countByEventAndStatus(eventId: EntityId, status: ScanLedgerStatus): Promise<number> {
    return [...this.scans.values()].filter((s) => s.eventId === eventId && s.status === status).length;
  }

  async countConsumedByEntitlement(entitlementId: EntityId): Promise<number> {
    return [...this.scans.values()].filter((s) => s.entitlementId === entitlementId && s.status === 'consumed').length;
  }

  async findOfflineScans(eventId: EntityId, before: Date): Promise<ScanLedger[]> {
    return [...this.scans.values()].filter(
      (s) => s.eventId === eventId && s.isOffline && new Date(s.scannedAt) < before,
    );
  }
}