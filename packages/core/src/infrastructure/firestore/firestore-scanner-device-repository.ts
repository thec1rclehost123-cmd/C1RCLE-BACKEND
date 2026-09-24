import { FieldValue } from 'firebase-admin/firestore';

import { scannerDeviceId } from '../../domain/models/scanner-device.js';

import { compareAndSet } from './compare-and-set.js';
import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { ScannerDevice } from '../../domain/models/scanner-device.js';
import type {
  ScannerDeviceRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_scanner_devices';

/** Firestore adapter for `ScannerDeviceRepository`. Same interface as memory. */
export class FirestoreScannerDeviceRepository implements ScannerDeviceRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async findById(id: EntityId): Promise<ScannerDevice | null> {
    const snap = await this.collection.doc(id).get();
    const data = snap.data();
    return data ? toDevice(data) : null;
  }

  async findByDevice(organizationId: EntityId, deviceId: string): Promise<ScannerDevice | null> {
    return this.findById(scannerDeviceId(organizationId, deviceId));
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<ScannerDevice>> {
    const base = this.collection
      .where('organizationId', '==', organizationId)
      .orderBy('lastSeenAt', 'desc');
    return paginateQuery(base, query, toDevice);
  }

  async save(device: ScannerDevice, _tx?: TxContext | null): Promise<void> {
    await compareAndSet(this.db, this.collection, device, toDoc);
  }

  /**
   * Liveness only. A heartbeat from every device every few seconds routed
   * through the version check would make ordinary traffic conflict with
   * itself; nothing written here is an invariant, so `update` with a counter
   * increment is both correct and the only thing that scales.
   */
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
    const update: DocumentData = { lastSeenAt: patch.lastSeenAt };
    if (patch.lastEventId !== undefined) update.lastEventId = patch.lastEventId;
    if (patch.lastGate !== undefined) update.lastGate = patch.lastGate;
    if (patch.lastScanAt !== undefined) update.lastScanAt = patch.lastScanAt;
    if (patch.lastScanResult !== undefined) update.lastScanResult = patch.lastScanResult;
    if (patch.incrementScanCount === true) update.scanCount = FieldValue.increment(1);
    // A heartbeat from a device that was unbound and deleted must not
    // resurrect the document, so this is an update, not a set-with-merge.
    await this.collection.doc(id).update(update);
  }
}

function toDoc(device: ScannerDevice): DocumentData {
  return { ...device };
}

function toDevice(data: DocumentData): ScannerDevice {
  return {
    id: data.id as string,
    organizationId: data.organizationId as string,
    venueId: (data.venueId as string | null) ?? null,
    deviceId: data.deviceId as string,
    deviceName: data.deviceName as string,
    status: data.status as ScannerDevice['status'],
    boundBy: data.boundBy as string,
    boundAt: data.boundAt as string,
    unboundAt: (data.unboundAt as string | null) ?? null,
    unboundReason: (data.unboundReason as string | null) ?? null,
    lastSeenAt: data.lastSeenAt as string,
    lastEventId: (data.lastEventId as string | null) ?? null,
    lastGate: (data.lastGate as string | null) ?? null,
    scanCount: (data.scanCount as number | undefined) ?? 0,
    lastScanAt: (data.lastScanAt as string | null) ?? null,
    lastScanResult: (data.lastScanResult as string | null) ?? null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
