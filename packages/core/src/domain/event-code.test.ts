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
  hashSessionToken,
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
    organizationId: 'org_1',
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

  it('generates a human-typeable code from an unambiguous CSPRNG alphabet', () => {
    const code = createEventCode(codeInput());
    // No O/0, I/1, S/5 or B/8: staff read these off one screen and type them
    // into another in a dark room.
    expect(code.code).toMatch(/^C1R-[ACDEFGHJKLMNPQRTUVWXYZ2346789]{8}$/);
  });

  it('does not repeat a code across calls (CSPRNG, not a predictable seed)', () => {
    const codes = new Set(Array.from({ length: 50 }, () => createEventCode(codeInput()).code));
    expect(codes.size).toBe(50);
  });

  it('mints a distinct opaque id under the 64-char cap', () => {
    const a = createEventCode(codeInput());
    const b = createEventCode(codeInput());
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeLessThanOrEqual(64);
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

  it('returns a raw token that is NEVER carried on the stored session', () => {
    const result = createScannerSession(sessionInput());
    expect(result.sessionToken).toMatch(/^scn_/);
    // The whole point: only the hash is persisted, so a database read (or a
    // leaked backup) cannot impersonate a scanner.
    expect(result.session.sessionToken).toBeNull();
    expect(result.session.permissions).toEqual(getSessionPermissions('full'));
    const expiresAt = new Date(result.sessionExpiresAt);
    expect(expiresAt.getTime() - T0.getTime()).toBe(12 * 60 * 60 * 1000);
  });

  it('does not embed the door code in the token', () => {
    const result = createScannerSession(sessionInput());
    // A leaked token must not also hand over the code that mints unlimited
    // further sessions.
    expect(result.sessionToken).not.toContain('C1R-ABCDEF');
  });

  it('scopes the session to the code owner’s organization, not the staff member', () => {
    const result = createScannerSession(sessionInput({ createdBy: 'staff_9' }));
    expect(result.session.organizationId).toBe('org_1');
    expect(result.session.createdBy).toBe('staff_9');
  });

  it('hashes a token deterministically and differently per token', () => {
    const a = createScannerSession(sessionInput());
    const b = createScannerSession(sessionInput());
    expect(hashSessionToken(a.sessionToken)).toBe(hashSessionToken(a.sessionToken));
    expect(hashSessionToken(a.sessionToken)).not.toBe(hashSessionToken(b.sessionToken));
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
