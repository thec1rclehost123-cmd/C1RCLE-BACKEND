import { AggregateField } from 'firebase-admin/firestore';

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
  ScanAdmissionStats,
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

  /**
   * Two server-side aggregates, not a document read: the total comes from a
   * `sum(admittedCount)` and the breakdown from one `sum` per entry class.
   * A busy night is tens of thousands of rows and the door polls this every
   * 20 seconds — reading them to add up a number in Node would cost more than
   * the scanning does.
   */
  /**
   * Server-side aggregates only — never a document read.
   *
   * One `sum(admittedCount)` for the total, then one more per tier the event
   * actually sells. Tier lists are small (typically two to six), so this is a
   * handful of aggregate queries whose cost does not grow with attendance —
   * which matters because the door polls this every few seconds all night.
   *
   * An earlier version sampled 5,000 ledger rows to derive the breakdown.
   * That was exact for a small night and silently wrong for a big one: the
   * total stayed right while the categories understated, which is the worst
   * kind of wrong because nothing looks broken. `unattributed` closes the
   * remainder so the parts always sum to the total.
   */
  async getAdmissionStats(
    eventId: EntityId,
    tierNames: readonly string[],
  ): Promise<ScanAdmissionStats> {
    const admittedRows = this.collection
      .where('eventId', '==', eventId)
      .where('admittedCount', '>', 0);

    const [totalSnap, ...tierSnaps] = await Promise.all([
      admittedRows.aggregate({ admitted: AggregateField.sum('admittedCount') }).get(),
      ...tierNames.map((tierName) =>
        admittedRows
          .where('tierName', '==', tierName)
          .aggregate({ admitted: AggregateField.sum('admittedCount') })
          .get(),
      ),
    ]);

    const byEntryType: Record<string, number> = {};
    let attributed = 0;
    tierNames.forEach((tierName, index) => {
      const admitted = tierSnaps[index]?.data().admitted ?? 0;
      byEntryType[tierName] = admitted;
      attributed += admitted;
    });

    const admitted = totalSnap.data().admitted ?? 0;
    return { admitted, byEntryType, unattributed: Math.max(0, admitted - attributed) };
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
