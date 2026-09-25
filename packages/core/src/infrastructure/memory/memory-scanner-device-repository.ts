import { VersionConflictError } from '../../domain/errors.js';
import { scannerDeviceId } from '../../domain/models/scanner-device.js';

import type { EntityId } from '../../domain/identity.js';
import type { ScannerDevice } from '../../domain/models/scanner-device.js';
import type {
  ScannerDeviceRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';

/** In-memory bound-device store for tests, CI and the memory storage driver. */
export class MemoryScannerDeviceRepository implements ScannerDeviceRepository {
  devices = new Map<EntityId, ScannerDevice>();

  async findById(id: EntityId): Promise<ScannerDevice | null> {
    return this.devices.get(id) ?? null;
  }

  async findByDevice(organizationId: EntityId, deviceId: string): Promise<ScannerDevice | null> {
    return this.findById(scannerDeviceId(organizationId, deviceId));
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<ScannerDevice>> {
    const all = [...this.devices.values()]
      .filter((d) => d.organizationId === organizationId)
      .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
    const start = query.cursor ? all.findIndex((d) => d.id === query.cursor) + 1 : 0;
    const end = Math.min(start + query.limit, all.length);
    const items = all.slice(start, end);
    return {
      items,
      total: all.length,
      nextCursor: end < all.length ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  async save(device: ScannerDevice, _tx?: TxContext | null): Promise<void> {
    const existing = this.devices.get(device.id);
    if (existing && existing.version !== device.version - 1) {
      throw new VersionConflictError(device.version - 1, existing.version);
    }
    this.devices.set(device.id, device);
  }

  /** Liveness only — no version bump, see the port's doc comment. */
  async touch(
    id: EntityId,
    patch: {
      lastSeenAt: string;
      lastEventId?: EntityId | null;
      lastGate?: string | null;
      lastScanAt?: string | null;
      lastScanResult?: string | null;
      incrementScanCount?: boolean;
    },
  ): Promise<void> {
    const device = this.devices.get(id);
    if (!device) return;
    this.devices.set(id, {
      ...device,
      lastSeenAt: patch.lastSeenAt,
      lastEventId: patch.lastEventId === undefined ? device.lastEventId : patch.lastEventId,
      lastGate: patch.lastGate === undefined ? device.lastGate : patch.lastGate,
      lastScanAt: patch.lastScanAt === undefined ? device.lastScanAt : patch.lastScanAt,
      lastScanResult:
        patch.lastScanResult === undefined ? device.lastScanResult : patch.lastScanResult,
      scanCount: patch.incrementScanCount === true ? device.scanCount + 1 : device.scanCount,
    });
  }
}
