import { describe, expect, it } from 'vitest';

import {
  canSessionCharge,
  canSessionDoorEntry,
  canSessionScan,
  canSessionWalkIn,
  createEventCode,
  createScannerSession,
  getSessionPermissions,
  isSessionValid,
} from './models/event-code.js';

import type { EventCodeCreateInput, ScannerSessionCreateInput } from './models/event-code.js';

const T0 = new Date('2026-09-01T18:00:00.000Z');

function codeInput(overrides: Partial<EventCodeCreateInput> = {}): EventCodeCreateInput {
  return {
    eventId: 'evt_1',
    organizationId: 'org_1',
    venueId: null,
    type: 'full',
    gate: null,
    createdBy: 'staff_1',
    createdByName: 'Staff One',
    expiresAt: null,
    now: T0,
    ...overrides,
  };
}

function sessionInput(
  overrides: Partial<ScannerSessionCreateInput> = {},
): ScannerSessionCreateInput {
  return {
    codeId: 'CODE-1',
    codeData: {
      id: 'CODE-1',
      code: 'C1R-ABCDEF',
      eventId: 'evt_1',
      venueId: null,
      type: 'full',
      gate: null,
      maxDevices: 5,
      allowReuse: false,
    },
    deviceId: 'device_1',
    deviceName: 'Gate iPad 1',
    createdBy: 'staff_1',
    createdByName: 'Staff One',
    sessionType: 'staff',
    now: T0,
    ...overrides,
  };
}

describe('createEventCode', () => {
  it('defaults to active status, 5 max devices, no reuse, zeroed stats', () => {
    const code = createEventCode(codeInput());
    expect(code.status).toBe('active');
    expect(code.maxDevices).toBe(5);
    expect(code.allowReuse).toBe(false);
    expect(code.stats).toEqual({
      scansCount: 0,
      doorEntriesCount: 0,
      doorRevenue: 0,
      lastUsedAt: null,
      activeSessions: 0,
    });
  });

  it('generates a human-readable C1R-XXXXXX code', () => {
    const code = createEventCode(codeInput());
    expect(code.code).toMatch(/^C1R-[0-9A-Z]{6}$/);
  });

  it('honors an explicit maxDevices/allowReuse override', () => {
    const code = createEventCode(codeInput({ maxDevices: 10, allowReuse: true }));
    expect(code.maxDevices).toBe(10);
    expect(code.allowReuse).toBe(true);
  });
});

describe('createScannerSession / getSessionPermissions', () => {
  it('grants full permissions for a `full` code', () => {
    expect(getSessionPermissions('full')).toEqual({
      canScan: true,
      canDoorEntry: true,
      canWalkIn: true,
      canCharge: false,
    });
  });

  it('grants scan + walk-in but not door-entry/charge for `scan_only`', () => {
    expect(getSessionPermissions('scan_only')).toEqual({
      canScan: true,
      canDoorEntry: false,
      canWalkIn: true,
      canCharge: false,
    });
  });

  it('grants only charge for `charge`', () => {
    expect(getSessionPermissions('charge')).toEqual({
      canScan: false,
      canDoorEntry: false,
      canWalkIn: false,
      canCharge: true,
    });
  });

  it('creates a session with a raw token, 12-hour expiry, and permissions matching the code type', () => {
    const result = createScannerSession(sessionInput());
    expect(result.sessionToken).toMatch(/^sess_/);
    expect(result.session.sessionToken).toBe(result.sessionToken);
    expect(result.session.permissions).toEqual(getSessionPermissions('full'));
    const expiresAt = new Date(result.sessionExpiresAt);
    expect(expiresAt.getTime() - T0.getTime()).toBe(12 * 60 * 60 * 1000);
  });

  it('derives scan_only permissions on the created session from codeData.type', () => {
    const result = createScannerSession(
      sessionInput({ codeData: { ...sessionInput().codeData, type: 'scan_only' } }),
    );
    expect(result.session.permissions).toEqual(getSessionPermissions('scan_only'));
  });
});

describe('isSessionValid', () => {
  // `isSessionValid` compares `expiresAt` against the real wall clock
  // (`new Date()`), not an injectable `now` — so these use offsets from the
  // actual present, not from the fixed `T0` fixture used elsewhere in this
  // file.
  it('is valid when unrevoked and unexpired', () => {
    expect(
      isSessionValid({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        revokedAt: null,
      }),
    ).toBe(true);
  });

  it('is invalid once revoked, regardless of expiry', () => {
    expect(
      isSessionValid({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        revokedAt: new Date().toISOString(),
      }),
    ).toBe(false);
  });

  it('is invalid once expired', () => {
    expect(
      isSessionValid({
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        revokedAt: null,
      }),
    ).toBe(false);
  });
});

describe('canSessionScan / canSessionDoorEntry / canSessionWalkIn / canSessionCharge', () => {
  it('read straight off the session permissions object', () => {
    const session = { permissions: getSessionPermissions('charge') };
    expect(canSessionScan(session)).toBe(false);
    expect(canSessionDoorEntry(session)).toBe(false);
    expect(canSessionWalkIn(session)).toBe(false);
    expect(canSessionCharge(session)).toBe(true);
  });
});
