import { describe, expect, it } from 'vitest';

import {
  bindScannerDevice,
  isDeviceAuthorized,
  rebindScannerDevice,
  scannerDeviceId,
  unbindScannerDevice,
} from './models/scanner-device.js';

const T0 = new Date('2026-09-15T20:00:00.000Z');

function device(overrides: Partial<Parameters<typeof bindScannerDevice>[0]> = {}) {
  return bindScannerDevice({
    organizationId: 'org_1',
    venueId: 'venue_1',
    deviceId: 'device_abcdefghijklmnop',
    deviceName: 'Gate iPad 1',
    boundBy: 'staff_1',
    now: T0,
    ...overrides,
  });
}

describe('scannerDeviceId', () => {
  it('scopes a device id to one organization', () => {
    // The same physical handset carried to another club is a different,
    // unbound device there — which is the correct answer, not a gap.
    expect(scannerDeviceId('org_1', 'dev_1')).not.toBe(scannerDeviceId('org_2', 'dev_1'));
  });
});

describe('bindScannerDevice', () => {
  it('starts active with zeroed counters and no unbind record', () => {
    const bound = device();
    expect(bound).toMatchObject({
      status: 'active',
      scanCount: 0,
      unboundAt: null,
      unboundReason: null,
      lastScanAt: null,
      boundBy: 'staff_1',
    });
    expect(bound.id).toBe(scannerDeviceId('org_1', 'device_abcdefghijklmnop'));
  });
});

describe('rebindScannerDevice', () => {
  it('refreshes a live device without erasing its history', () => {
    const bound = { ...device(), scanCount: 42, boundAt: '2026-09-01T00:00:00.000Z' };
    const again = rebindScannerDevice(bound, {
      deviceName: 'Gate iPad 1 (renamed)',
      venueId: 'venue_1',
      boundBy: 'staff_2',
      now: new Date('2026-09-15T21:00:00.000Z'),
    });
    expect(again.deviceName).toBe('Gate iPad 1 (renamed)');
    // The app re-registers on every launch; resetting these each time would
    // erase exactly what a manager looks at when a handset misbehaves.
    expect(again.scanCount).toBe(42);
    expect(again.boundAt).toBe('2026-09-01T00:00:00.000Z');
    expect(again.boundBy).toBe('staff_1');
    expect(again.version).toBe(bound.version + 1);
  });

  it('records who let an unbound device back in', () => {
    const revoked = unbindScannerDevice(device(), 'lost', T0);
    const restored = rebindScannerDevice(revoked, {
      deviceName: 'Gate iPad 1',
      venueId: 'venue_1',
      boundBy: 'manager_9',
      now: new Date('2026-09-16T02:00:00.000Z'),
    });
    expect(restored).toMatchObject({
      status: 'active',
      boundBy: 'manager_9',
      unboundAt: null,
      unboundReason: null,
    });
    expect(restored.boundAt).toBe('2026-09-16T02:00:00.000Z');
  });
});

describe('unbindScannerDevice / isDeviceAuthorized', () => {
  it('unbinding keeps why and when, and revokes authorization', () => {
    const revoked = unbindScannerDevice(device(), 'handset stolen', T0);
    expect(revoked).toMatchObject({
      status: 'unbound',
      unboundReason: 'handset stolen',
      unboundAt: T0.toISOString(),
    });
    expect(isDeviceAuthorized(revoked)).toBe(false);
  });

  it('fails closed on an unknown device', () => {
    // An absent binding is not an authorized one.
    expect(isDeviceAuthorized(null)).toBe(false);
    expect(isDeviceAuthorized(device())).toBe(true);
  });
});
