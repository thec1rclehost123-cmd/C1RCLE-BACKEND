import { createScanLedger, overrideScan } from '../../domain/models/scan-ledger.js';

import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  ScanLedger,
  ScanLedgerCreateInput,
  ScanLedgerStatus,
  ScanDenyReason,
} from '../../domain/models/scan-ledger.js';
import type {
  ScanLedgerRepository,
  Page,
  PaginationQuery,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_scan_ledger';

export class FirestoreScanLedgerRepository implements ScanLedgerRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async create(input: ScanLedgerCreateInput): Promise<ScanLedger> {
    const scan = createScanLedger(input);
    await this.collection.doc(scan.id).set(toDoc(scan));
    return scan;
  }

  async findById(id: EntityId): Promise<ScanLedger | null> {
    const snap = await this.collection.doc(id).get();
    const data = snap.data();
    return data ? toScanLedger(data) : null;
  }

  async findByEventAndEntitlement(
    eventId: EntityId,
    entitlementId: EntityId,
  ): Promise<ScanLedger | null> {
    const snap = await this.collection
      .where('eventId', '==', eventId)
      .where('entitlementId', '==', entitlementId)
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return doc ? toScanLedger(doc.data()) : null;
  }

  async findByEvent(eventId: EntityId, input: PaginationQuery): Promise<Page<ScanLedger>> {
    const base = this.collection.where('eventId', '==', eventId).orderBy('scannedAt', 'desc');
    return paginateQuery(base, input, toScanLedger);
  }

  async findByOrganization(
    organizationId: EntityId,
    input: PaginationQuery,
  ): Promise<Page<ScanLedger>> {
    const base = this.collection
      .where('organizationId', '==', organizationId)
      .orderBy('scannedAt', 'desc');
    return paginateQuery(base, input, toScanLedger);
  }

  async findByDevice(deviceId: string, input: PaginationQuery): Promise<Page<ScanLedger>> {
    const base = this.collection.where('deviceId', '==', deviceId).orderBy('scannedAt', 'desc');
    return paginateQuery(base, input, toScanLedger);
  }

  async findByOperator(operatorUid: string, input: PaginationQuery): Promise<Page<ScanLedger>> {
    const base = this.collection
      .where('operatorUid', '==', operatorUid)
      .orderBy('scannedAt', 'desc');
    return paginateQuery(base, input, toScanLedger);
  }

  async updateStatus(
    id: EntityId,
    status: ScanLedgerStatus,
    denyReason?: ScanDenyReason,
    denyMessage?: string,
  ): Promise<ScanLedger | null> {
    const ref = this.collection.doc(id);
    const updates: Record<string, unknown> = { status, updatedAt: new Date().toISOString() };
    if (denyReason) updates.denyReason = denyReason;
    if (denyMessage) updates.denyMessage = denyMessage;
    await ref.update(updates);
    const snap = await ref.get();
    const data = snap.data();
    return data ? toScanLedger(data) : null;
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
    const ref = this.collection.doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!data) return null;
      // Throws on an illegal transition (e.g. already consumed) — the FSM
      // guard lives in the domain function, not duplicated here.
      const updated = overrideScan(toScanLedger(data), overriddenBy, reason);
      tx.set(ref, toDoc(updated));
      return updated;
    });
  }

  async countByEventAndStatus(eventId: EntityId, status: ScanLedgerStatus): Promise<number> {
    const snap = await this.collection
      .where('eventId', '==', eventId)
      .where('status', '==', status)
      .count()
      .get();
    return snap.data().count;
  }

  async countConsumedByEntitlement(entitlementId: EntityId): Promise<number> {
    const snap = await this.collection
      .where('entitlementId', '==', entitlementId)
      .where('status', '==', 'consumed')
      .count()
      .get();
    return snap.data().count;
  }

  async findOfflineScans(eventId: EntityId, before: Date): Promise<ScanLedger[]> {
    const snap = await this.collection
      .where('eventId', '==', eventId)
      .where('isOffline', '==', true)
      .where('scannedAt', '<', before.toISOString())
      .get();
    return snap.docs.map((doc) => toScanLedger(doc.data()));
  }
}

function toDoc(scan: ScanLedger): DocumentData {
  return {
    id: scan.id,
    eventId: scan.eventId,
    organizationId: scan.organizationId,
    venueId: scan.venueId,
    entitlementId: scan.entitlementId,
    doorSaleId: scan.doorSaleId,
    entryType: scan.entryType,
    tierName: scan.tierName,
    tierId: scan.tierId,
    operatorUid: scan.operatorUid,
    operatorName: scan.operatorName,
    operatorRole: scan.operatorRole,
    gate: scan.gate,
    deviceId: scan.deviceId,
    deviceName: scan.deviceName,
    deviceBound: scan.deviceBound,
    status: scan.status,
    denyReason: scan.denyReason,
    denyMessage: scan.denyMessage,
    guestName: scan.guestName,
    guestEmail: scan.guestEmail,
    guestPhone: scan.guestPhone,
    scannedAt: scan.scannedAt,
    admittedCount: scan.admittedCount,
    scanCountUsed: scan.scanCountUsed,
    scanCountAllowed: scan.scanCountAllowed,
    isOffline: scan.isOffline,
    syncedAt: scan.syncedAt,
    offlineDeviceId: scan.offlineDeviceId,
    overriddenBy: scan.overriddenBy,
    overrideReason: scan.overrideReason,
    version: scan.version,
    createdAt: scan.createdAt,
    updatedAt: scan.updatedAt,
  };
}

function toScanLedger(data: DocumentData): ScanLedger {
  return {
    id: data.id as string,
    eventId: data.eventId as string,
    organizationId: data.organizationId as string,
    venueId: data.venueId as string | null,
    entitlementId: data.entitlementId as string | null,
    doorSaleId: data.doorSaleId as string | null,
    entryType: data.entryType as string | null,
    tierName: data.tierName as string | null,
    tierId: data.tierId as string | null,
    operatorUid: data.operatorUid as string | null,
    operatorName: data.operatorName as string | null,
    operatorRole: data.operatorRole as string | null,
    gate: data.gate as string | null,
    deviceId: data.deviceId as string | null,
    deviceName: data.deviceName as string | null,
    deviceBound: data.deviceBound as boolean,
    status: data.status as ScanLedgerStatus,
    denyReason: data.denyReason as ScanDenyReason | null,
    denyMessage: data.denyMessage as string | null,
    guestName: data.guestName as string | null,
    guestEmail: data.guestEmail as string | null,
    guestPhone: data.guestPhone as string | null,
    scannedAt: data.scannedAt as string,
    admittedCount: data.admittedCount as number,
    scanCountUsed: data.scanCountUsed as number | null,
    scanCountAllowed: data.scanCountAllowed as number | null,
    isOffline: data.isOffline as boolean,
    syncedAt: data.syncedAt as string | null,
    offlineDeviceId: data.offlineDeviceId as string | null,
    overriddenBy: (data.overriddenBy as string | null) ?? null,
    overrideReason: (data.overrideReason as string | null) ?? null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
