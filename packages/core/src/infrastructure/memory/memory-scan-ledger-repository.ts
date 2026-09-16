import { VersionConflictError } from '../../domain/errors.js';
import { createScanLedger, overrideScan } from '../../domain/models/scan-ledger.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  ScanLedger,
  ScanLedgerCreateInput,
  ScanLedgerStatus,
  ScanDenyReason,
} from '../../domain/models/scan-ledger.js';
import type {
  ScanAdmissionStats,
  ScanLedgerRepository,
  Page,
  PaginationQuery,
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

function serializeSlice<T extends { id: EntityId }>(all: T[], query: PaginationQuery): Page<T> {
  const { cursor, limit } = query;
  const start = cursor ? all.findIndex((item) => item.id === cursor) + 1 : 0;
  const end = Math.min(start + limit, all.length);
  const items = all.slice(start, end);
  const nextCursor =
    end < all.length && items.length > 0 ? (items[items.length - 1]?.id ?? null) : null;
  return { items, total: all.length, nextCursor };
}

export class MemoryScanLedgerRepository implements ScanLedgerRepository {
  scans = new Map<EntityId, ScanLedger>();

  async create(input: ScanLedgerCreateInput): Promise<ScanLedger> {
    const scan = createScanLedger(input);
    casSet(this.scans, scan);
    return scan;
  }

  async findById(id: EntityId): Promise<ScanLedger | null> {
    return this.scans.get(id) ?? null;
  }

  async findByEventAndEntitlement(
    eventId: EntityId,
    entitlementId: EntityId,
  ): Promise<ScanLedger | null> {
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

  async findByOrganization(
    organizationId: EntityId,
    input: PaginationQuery,
  ): Promise<Page<ScanLedger>> {
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
    const updated = {
      ...scan,
      status,
      denyReason: denyReason ?? scan.denyReason,
      denyMessage: denyMessage ?? scan.denyMessage,
      version: scan.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.scans.set(id, updated);
    return updated;
  }

  async markConsumed(id: EntityId): Promise<ScanLedger | null> {
    return this.updateStatus(id, 'consumed');
  }

  async markDenied(
    id: EntityId,
    reason: ScanDenyReason,
    message: string,
  ): Promise<ScanLedger | null> {
    return this.updateStatus(id, 'denied', reason, message);
  }

  async markCancelled(id: EntityId): Promise<ScanLedger | null> {
    return this.updateStatus(id, 'cancelled');
  }

  async markOverridden(
    id: EntityId,
    overriddenBy: string,
    reason: string,
  ): Promise<ScanLedger | null> {
    const scan = this.scans.get(id);
    if (!scan) return null;
    // Throws on an illegal transition (e.g. already consumed) — the FSM
    // guard lives in the domain function, not duplicated here.
    const updated = overrideScan(scan, overriddenBy, reason);
    this.scans.set(id, updated);
    return updated;
  }

  async countByEventAndStatus(eventId: EntityId, status: ScanLedgerStatus): Promise<number> {
    return [...this.scans.values()].filter((s) => s.eventId === eventId && s.status === status)
      .length;
  }

  async getAdmissionStats(
    eventId: EntityId,
    tierNames: readonly string[],
  ): Promise<ScanAdmissionStats> {
    const byEntryType: Record<string, number> = {};
    for (const tierName of tierNames) byEntryType[tierName] = 0;

    let admitted = 0;
    let attributed = 0;
    for (const scan of this.scans.values()) {
      if (scan.eventId !== eventId) continue;
      if (scan.admittedCount <= 0) continue;
      admitted += scan.admittedCount;
      const key = scan.tierName;
      if (key !== null && key in byEntryType) {
        byEntryType[key] = (byEntryType[key] ?? 0) + scan.admittedCount;
        attributed += scan.admittedCount;
      }
    }
    return { admitted, byEntryType, unattributed: Math.max(0, admitted - attributed) };
  }

  async countConsumedByEntitlement(entitlementId: EntityId): Promise<number> {
    return [...this.scans.values()].filter(
      (s) => s.entitlementId === entitlementId && s.status === 'consumed',
    ).length;
  }

  async findOfflineScans(eventId: EntityId, before: Date): Promise<ScanLedger[]> {
    return [...this.scans.values()].filter(
      (s) => s.eventId === eventId && s.isOffline && new Date(s.scannedAt) < before,
    );
  }
}
