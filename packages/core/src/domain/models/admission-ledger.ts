import { createScanLedger } from './scan-ledger.js';

import type { Entitlement } from './entitlement.js';
import type { Event } from './event.js';
import type { ClaimAdmissionOptions } from '../ports/repositories.js';

/** The consumed ledger is a fact of the same atomic admission, never a later best effort. */
export function admissionLedger(
  ticket: Entitlement,
  previousScans: number,
  event: Event,
  audit: NonNullable<ClaimAdmissionOptions['admissionAudit']>,
  now: Date,
) {
  return createScanLedger({
    eventId: event.id,
    organizationId: ticket.organizationId,
    venueId: event.venueId,
    entitlementId: ticket.id,
    doorSaleId: null,
    entryType: 'ticket',
    tierName: ticket.tierName,
    tierId: ticket.tierId,
    operatorUid: audit.operatorUserId,
    operatorName: audit.operatorName ?? null,
    operatorRole: audit.operatorRole ?? null,
    gate: audit.gate ?? null,
    deviceId: audit.deviceId,
    deviceName: audit.deviceName ?? null,
    deviceBound: true,
    guestName: ticket.holderName,
    guestEmail: null,
    guestPhone: null,
    scannedAt: now.toISOString(),
    admittedCount: ticket.scanCount - previousScans,
    scanCountUsed: ticket.scanCount,
    scanCountAllowed: ticket.scanCountAllowed,
    isOffline: false,
    offlineDeviceId: null,
    status: 'consumed',
    denyReason: null,
    denyMessage: null,
    now,
  });
}
