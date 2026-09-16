import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Bound scanner device (Phase 5) ─────────────────────────────────────────
 *
 * A physical phone or tablet that a venue has authorized to work its door.
 *
 * Why this exists as its own aggregate rather than as a field on the session:
 * a session lasts one shift, a device lasts as long as the venue owns the
 * handset. A manager who loses a phone needs to stop *that phone* working
 * tonight and next Saturday, without hunting down whichever sessions happen
 * to be open. Unbinding here does that in one write.
 *
 * The id is `${organizationId}_${deviceId}`, so a device id is only ever
 * meaningful inside one tenant. The same handset walked across the street to
 * another club is a different, unbound device there — which is the correct
 * answer, not an inconvenience.
 *
 * The device id itself is opaque and client-generated (the app mints one
 * random value on first launch and keeps it). It is deliberately NOT derived
 * from hardware identifiers: those are privacy-sensitive, often unavailable,
 * and — crucially — not a security boundary, since anything the client can
 * read the client can also claim. The security comes from the binding record
 * and the session token, not from the id being hard to guess.
 */

export type ScannerDeviceStatus = 'active' | 'unbound';

export interface ScannerDevice extends VersionedEntity {
  /** `${organizationId}_${deviceId}` */
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId | null;
  /** Opaque, client-generated, stable for the life of the install. */
  deviceId: string;
  /** Human label staff can recognize in a device list ("Gate iPad 1"). */
  deviceName: string;
  status: ScannerDeviceStatus;
  /** Who authorized it, and when. */
  boundBy: EntityId;
  boundAt: string;
  unboundAt: string | null;
  unboundReason: string | null;
  /** Liveness — how the dashboard knows which scanners are on the door now. */
  lastSeenAt: string;
  lastEventId: EntityId | null;
  lastGate: string | null;
  /** Rolling per-device counters, for "this phone is denying everything". */
  scanCount: number;
  lastScanAt: string | null;
  lastScanResult: string | null;
}

export function scannerDeviceId(organizationId: EntityId, deviceId: string): EntityId {
  return `${organizationId}_${deviceId}`;
}

export interface BindScannerDeviceInput {
  organizationId: EntityId;
  venueId: EntityId | null;
  deviceId: string;
  deviceName: string;
  boundBy: EntityId;
  now?: Date;
}

export function bindScannerDevice(input: BindScannerDeviceInput): ScannerDevice {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  return {
    id: scannerDeviceId(input.organizationId, input.deviceId),
    organizationId: input.organizationId,
    venueId: input.venueId,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    status: 'active',
    boundBy: input.boundBy,
    boundAt: at,
    unboundAt: null,
    unboundReason: null,
    lastSeenAt: at,
    lastEventId: null,
    lastGate: null,
    scanCount: 0,
    lastScanAt: null,
    lastScanResult: null,
    ...newVersionedEntity(now),
  };
}

/**
 * Re-binding an already-bound device is a refresh, not a new binding: the app
 * calls this on every launch, and resetting `boundAt` or the scan counters
 * each time would erase exactly the history a manager looks at when a device
 * misbehaves. An unbound device is re-activated deliberately, with a fresh
 * `boundBy` recording who let it back in.
 */
export function rebindScannerDevice(
  device: ScannerDevice,
  input: { deviceName: string; venueId: EntityId | null; boundBy: EntityId; now?: Date },
): ScannerDevice {
  const now = input.now ?? new Date();
  const reactivating = device.status !== 'active';
  return {
    ...bumpVersion(device, now),
    deviceName: input.deviceName,
    venueId: input.venueId,
    status: 'active',
    boundBy: reactivating ? input.boundBy : device.boundBy,
    boundAt: reactivating ? now.toISOString() : device.boundAt,
    unboundAt: null,
    unboundReason: null,
    lastSeenAt: now.toISOString(),
  };
}

export function unbindScannerDevice(
  device: ScannerDevice,
  reason: string,
  now?: Date,
): ScannerDevice {
  const at = now ?? new Date();
  return {
    ...bumpVersion(device, at),
    status: 'unbound',
    unboundAt: at.toISOString(),
    unboundReason: reason,
  };
}

/** The check every scan runs. Fails closed: an unknown device is not bound. */
export function isDeviceAuthorized(device: ScannerDevice | null): device is ScannerDevice {
  return device !== null && device.status === 'active';
}
