import { createHash } from 'node:crypto';

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
 * The id is a hash of `organizationId` and `deviceId`, so a device id is only
 * ever meaningful inside one tenant. The same handset walked across the street
 * to another club is a different, unbound device there — which is the correct
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
  /** Hash of `organizationId` + `deviceId` — see `scannerDeviceId`. */
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

/**
 * Deterministic — `findByDevice` reconstructs it rather than querying — and
 * fixed-width, which is the part that matters.
 *
 * This was `${organizationId}_${deviceId}` and it overflowed the platform's
 * 64-character opaque-id cap in production shapes: a UUID organization id is
 * 36 characters and `deviceId` is allowed up to 128, so the composite reached
 * ~165 and every `POST /door/devices` response failed schema validation with
 * a 500. It passed every test because the fixtures used `org_1`.
 *
 * That is the third time this exact bug has appeared in this repo — see
 * `entitlementId` and `scanLedgerId`, whose comments tell the same story. The
 * shape of the mistake is always "readable composite id" meeting real UUIDs,
 * and it is always invisible until someone uses a realistic id. Hashing is
 * the fix, and `id-length.test.ts` now guards the whole family.
 */
export function scannerDeviceId(organizationId: EntityId, deviceId: string): EntityId {
  const digest = createHash('sha256').update(`${organizationId}:${deviceId}`).digest('hex');
  return `SDEV-${digest.slice(0, 32)}`;
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
