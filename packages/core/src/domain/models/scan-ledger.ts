import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Scan Ledger (Phase 5) ─────────────────────────────────────────────────────
 *
 * Immutable record of every scan attempt. Ported from v1's `entitlement-engine.js`
 * and `scan-engine.js` (non-deprecated path). State machine:
 * `PENDING → CONSUMED | DENIED` (terminal) / `REVOKED` / `EXPIRED`.
 *
 * "Magic Ticket" rotating QR for tickets ≥ ₹5000:
 * `HMAC(entitlementId : floor(unixTime/30))` — rotates every 30s, screenshot
 * useless within half a minute; verify checks current + previous window
 * (±65s clock-drift tolerance).
 */

export type ScanLedgerStatus =
  /** Scan queued for processing (rare, for offline sync) */
  | 'pending'
  /** Entry approved — entitlement consumed */
  | 'consumed'
  /** Entry denied — reason stored in `denyReason` */
  | 'denied'
  /** Scan cancelled before processing (e.g., duplicate detected early) */
  | 'cancelled'
  /** Scan record revoked (admin action) */
  | 'revoked'
  /** Scan expired before processing (offline sync timeout) */
  | 'expired';

const SCAN_LEDGER_TRANSITIONS: Readonly<Record<ScanLedgerStatus, readonly ScanLedgerStatus[]>> = {
  pending: ['consumed', 'denied', 'cancelled', 'expired'],
  consumed: ['revoked'],
  denied: ['revoked'],
  cancelled: ['revoked'],
  expired: ['revoked'],
  revoked: [],
};

export type ScanDenyReason =
  | 'invalid_signature'
  | 'already_used'
  | 'expired'
  | 'wrong_event'
  | 'device_invalid'
  | 'void_ticket'
  | 'capacity_exceeded'
  | 'wrong_gate'
  | 'offline_expired'
  | 'override_required'
  | 'capacity_exceeded'
  | 'promoter_not_authorized';

export interface ScanLedger extends VersionedEntity {
  /** Deterministic: `${eventId}_${entitlementId}_${scanIndex}` or `${eventId}_${entitlementId}` for single-scan tickets */
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  venueId: EntityId | null;
  /** The entitlement that was scanned (for ticket scans) */
  entitlementId: EntityId | null;
  /** For walk-in/dine-in sales */
  doorSaleId: EntityId | null;
  /** The entitlement type (general, couple, vip, etc.) */
  entryType: string | null;
  /** Ticket tier name at time of scan */
  tierName: string | null;
  /** Ticket tier ID at time of scan */
  tierId: EntityId | null;
  /** Who scanned (operator UID) */
  operatorUid: string | null;
  /** Operator display name */
  operatorName: string | null;
  /** Operator role */
  operatorRole: string | null;
  /** Gate identifier */
  gate: string | null;
  /** Device ID used for scan */
  deviceId: string | null;
  /** Device name (for audit) */
  deviceName: string | null;
  /** Whether device was registered/bound */
  deviceBound: boolean;
  /** Scan result */
  status: ScanLedgerStatus;
  /** If denied, why */
  denyReason: ScanDenyReason | null;
  /** Human-readable deny message */
  denyMessage: string | null;
  /** Guest name (for audit) */
  guestName: string | null;
  /** Guest email (if available) */
  guestEmail: string | null;
  /** Guest phone (if available) */
  guestPhone: string | null;
  /** Scan timestamp (ISO-8601) */
  scannedAt: string;
  /** Number of people admitted by this scan */
  admittedCount: number;
  /** For entitlement scans: how many scans used vs allowed */
  scanCountUsed: number | null;
  scanCountAllowed: number | null;
  /** Offline scan flag */
  isOffline: boolean;
  /** Offline sync timestamp (if applicable) */
  syncedAt: string | null;
  /** Offline device ID (for audit) */
  offlineDeviceId: string | null;
}

export function canTransitionScan(
  from: ScanLedgerStatus,
  to: ScanLedgerStatus,
): boolean {
  return SCAN_LEDGER_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface ScanLedgerCreateInput {
  eventId: EntityId;
  organizationId: EntityId;
  venueId: EntityId | null;
  entitlementId: EntityId | null;
  doorSaleId: EntityId | null;
  entryType: string | null;
  tierName: string | null;
  tierId: EntityId | null;
  operatorUid: string | null;
  operatorName: string | null;
  operatorRole: string | null;
  gate: string | null;
  deviceId: string | null;
  deviceName: string | null;
  deviceBound: boolean;
  guestName: string | null;
  guestEmail: string | null;
  guestPhone: string | null;
  scannedAt: string;
  admittedCount: number;
  scanCountUsed: number | null;
  scanCountAllowed: number | null;
  isOffline: boolean;
  offlineDeviceId: string | null;
  now?: Date;
}

export function createScanLedger(input: ScanLedgerCreateInput): ScanLedger {
  const now = input.now ?? new Date();
  return {
    id: `SCAN-${input.eventId}-${input.entitlementId ?? 'walkin'}-${Date.now()}`,
    eventId: input.eventId,
    organizationId: input.organizationId,
    venueId: input.venueId,
    entitlementId: input.entitlementId,
    doorSaleId: input.doorSaleId,
    entryType: input.entryType,
    tierName: input.tierName,
    tierId: input.tierId,
    operatorUid: input.operatorUid,
    operatorName: input.operatorName,
    operatorRole: input.operatorRole,
    gate: input.gate,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    deviceBound: input.deviceBound,
    status: 'pending',
    denyReason: null,
    denyMessage: null,
    guestName: input.guestName,
    guestEmail: input.guestEmail,
    guestPhone: input.guestPhone,
    scannedAt: input.scannedAt,
    admittedCount: input.admittedCount,
    scanCountUsed: input.scanCountUsed,
    scanCountAllowed: input.scanCountAllowed,
    isOffline: input.isOffline,
    offlineDeviceId: input.offlineDeviceId,
    syncedAt: null,
    ...newVersionedEntity(now),
  };
}

export function transitionScanLedger(
  ledger: any,
  to: ScanLedgerStatus,
  denyReason: any = null,
  denyMessage: any = null,
  now?: Date,
): any {
  if (!canTransitionScan(ledger.status, to)) {
    throw new Error(`Cannot transition scan ledger from ${ledger.status} to ${to}`);
  }
  const at = now ?? new Date();
  const next = {
    ...bumpVersion(ledger, at),
    status: to,
    denyReason,
    denyMessage,
  };
  if (to === 'consumed') {
    return {
      ...next,
      status: 'consumed',
    };
  }
  return next;
}

export function markScanConsumed(
  ledger: any,
  now?: Date,
): any {
  return transitionScanLedger(ledger, 'consumed', null, null, now);
}

export function markScanDenied(
  ledger: any,
  reason: any,
  message: any,
  now?: Date,
): any {
  return transitionScanLedger(ledger, 'denied', reason, message, now);
}

export function markScanCancelled(
  ledger: any,
  now?: Date,
): any {
  return transitionScanLedger(ledger, 'cancelled', null, null, now);
}

export function isScanPending(ledger: any): boolean {
  return ledger.status === 'pending';
}

export function isScanConsumed(ledger: any): boolean {
  return ledger.status === 'consumed';
}

export function isScanDenied(ledger: any): boolean {
  return ledger.status === 'denied';
}

export function isScanTerminal(ledger: any): boolean {
  return ['consumed', 'denied', 'revoked', 'expired'].includes(ledger.status);
}

export function isScanDeniedFor(ledger: any, reason: any): boolean {
  return ledger.status === 'denied' && ledger.denyReason === reason;
}

export function isScanAlreadyConsumed(ledger: any): boolean {
  return ledger.status === 'consumed';
}

export function isScanPendingOrActive(ledger: any): boolean {
  return ledger.status === 'pending';
}