import { describe, expect, it } from 'vitest';

import {
  canTransitionScan,
  createScanLedger,
  isScanConsumed,
  isScanDenied,
  isScanDeniedFor,
  isScanPending,
  isScanTerminal,
  markScanCancelled,
  markScanConsumed,
  markScanDenied,
  overrideScan,
  transitionScanLedger,
} from './models/scan-ledger.js';

import type { ScanLedgerCreateInput } from './models/scan-ledger.js';

const T0 = new Date('2026-09-01T18:00:00.000Z');

function input(overrides: Partial<ScanLedgerCreateInput> = {}): ScanLedgerCreateInput {
  return {
    eventId: 'evt_1',
    organizationId: 'org_1',
    venueId: null,
    entitlementId: 'ent_1',
    doorSaleId: null,
    entryType: null,
    tierName: 'General',
    tierId: 'tier_1',
    operatorUid: 'staff_1',
    operatorName: 'Staff One',
    operatorRole: 'staff',
    gate: null,
    deviceId: 'device_1',
    deviceName: 'Gate iPad 1',
    deviceBound: true,
    guestName: null,
    guestEmail: null,
    guestPhone: null,
    scannedAt: T0.toISOString(),
    admittedCount: 0,
    scanCountUsed: 0,
    scanCountAllowed: 1,
    isOffline: false,
    offlineDeviceId: null,
    now: T0,
    ...overrides,
  };
}

describe('createScanLedger', () => {
  it('defaults to pending with no deny reason/message and no override fields', () => {
    const ledger = createScanLedger(input());
    expect(ledger.status).toBe('pending');
    expect(ledger.denyReason).toBeNull();
    expect(ledger.denyMessage).toBeNull();
    expect(ledger.overriddenBy).toBeNull();
    expect(ledger.overrideReason).toBeNull();
    expect(ledger.syncedAt).toBeNull();
    expect(ledger.version).toBe(1);
  });

  it('accepts an explicit terminal status + deny reason at creation (deny-at-write path)', () => {
    const ledger = createScanLedger(
      input({
        status: 'denied',
        denyReason: 'already_used',
        denyMessage: 'Ticket already scanned',
      }),
    );
    expect(ledger.status).toBe('denied');
    expect(ledger.denyReason).toBe('already_used');
    expect(ledger.denyMessage).toBe('Ticket already scanned');
  });

  it('mints a hashed id that stays within the 64-char opaque-ID cap even with long UUID inputs', () => {
    const longEventId = '11111111-2222-3333-4444-555555555555';
    const longEntitlementId = 'ENT-66666666-7777-8888-9999-aaaaaaaaaaaa';
    const ledger = createScanLedger(
      input({ eventId: longEventId, entitlementId: longEntitlementId }),
    );
    expect(ledger.id.length).toBeLessThanOrEqual(64);
    expect(ledger.id).toMatch(/^SCAN-[0-9a-f]{32}$/);
  });

  it('produces a different id for a walk-in scan (null entitlementId) than a ticket scan', () => {
    const ticket = createScanLedger(input({ entitlementId: 'ent_1' }));
    const walkin = createScanLedger(input({ entitlementId: null }));
    expect(ticket.id).not.toBe(walkin.id);
  });
});

describe('canTransitionScan', () => {
  it('allows every legal transition from pending', () => {
    expect(canTransitionScan('pending', 'consumed')).toBe(true);
    expect(canTransitionScan('pending', 'denied')).toBe(true);
    expect(canTransitionScan('pending', 'cancelled')).toBe(true);
    expect(canTransitionScan('pending', 'expired')).toBe(true);
  });

  it('allows denied -> overridden and denied -> revoked, nothing else', () => {
    expect(canTransitionScan('denied', 'overridden')).toBe(true);
    expect(canTransitionScan('denied', 'revoked')).toBe(true);
    expect(canTransitionScan('denied', 'consumed')).toBe(false);
    expect(canTransitionScan('denied', 'pending')).toBe(false);
  });

  it('allows consumed -> revoked only', () => {
    expect(canTransitionScan('consumed', 'revoked')).toBe(true);
    expect(canTransitionScan('consumed', 'denied')).toBe(false);
    expect(canTransitionScan('consumed', 'overridden')).toBe(false);
  });

  it('treats revoked and overridden as terminal — no outbound transitions', () => {
    expect(canTransitionScan('revoked', 'consumed')).toBe(false);
    expect(canTransitionScan('revoked', 'denied')).toBe(false);
    expect(canTransitionScan('overridden', 'denied')).toBe(false);
    expect(canTransitionScan('overridden', 'revoked')).toBe(false);
  });
});

describe('transitionScanLedger / markScan*', () => {
  it('markScanConsumed clears any prior deny reason/message', () => {
    const pending = createScanLedger(input());
    const consumed = markScanConsumed(pending, T0);
    expect(consumed.status).toBe('consumed');
    expect(consumed.denyReason).toBeNull();
    expect(consumed.denyMessage).toBeNull();
    expect(consumed.version).toBe(pending.version + 1);
  });

  it('markScanDenied records the reason and message', () => {
    const pending = createScanLedger(input());
    const denied = markScanDenied(pending, 'expired', 'Ticket window closed', T0);
    expect(denied.status).toBe('denied');
    expect(denied.denyReason).toBe('expired');
    expect(denied.denyMessage).toBe('Ticket window closed');
  });

  it('markScanCancelled transitions pending -> cancelled', () => {
    const pending = createScanLedger(input());
    expect(markScanCancelled(pending, T0).status).toBe('cancelled');
  });

  it('throws a plain Error (not a domain error type) on an illegal transition', () => {
    const consumed = markScanConsumed(createScanLedger(input()), T0);
    expect(() => transitionScanLedger(consumed, 'denied', 'expired', 'nope', T0)).toThrow(
      'Cannot transition scan ledger from consumed to denied',
    );
  });
});

describe('overrideScan', () => {
  it('admits a denied scan: sets overriddenBy/overrideReason, keeps the original deny reason, forces admittedCount >= 1', () => {
    const denied = markScanDenied(
      createScanLedger(input()),
      'already_used',
      'Ticket already scanned',
      T0,
    );
    const overridden = overrideScan(denied, 'staff_2', 'manager override at the door', T0);
    expect(overridden.status).toBe('overridden');
    expect(overridden.overriddenBy).toBe('staff_2');
    expect(overridden.overrideReason).toBe('manager override at the door');
    // The story of why it was denied is preserved, not erased.
    expect(overridden.denyReason).toBe('already_used');
    expect(overridden.denyMessage).toBe('Ticket already scanned');
    expect(overridden.admittedCount).toBe(1);
    expect(overridden.version).toBe(denied.version + 1);
  });

  it('does not lower an already-nonzero admittedCount', () => {
    const denied = {
      ...markScanDenied(createScanLedger(input()), 'already_used', 'x', T0),
      admittedCount: 2,
    };
    const overridden = overrideScan(denied, 'staff_2', 'reason', T0);
    expect(overridden.admittedCount).toBe(2);
  });

  it('rejects overriding a scan that is not denied, with a StateTransitionError', () => {
    const consumed = markScanConsumed(createScanLedger(input()), T0);
    expect(() => overrideScan(consumed, 'staff_2', 'reason', T0)).toThrow(
      /Illegal state transition consumed -> overridden/,
    );
  });

  it('rejects overriding a pending scan', () => {
    const pending = createScanLedger(input());
    expect(() => overrideScan(pending, 'staff_2', 'reason', T0)).toThrow();
  });
});

describe('predicates', () => {
  it('isScanPending / isScanConsumed / isScanDenied read status directly', () => {
    const pending = createScanLedger(input());
    expect(isScanPending(pending)).toBe(true);
    expect(isScanConsumed(markScanConsumed(pending, T0))).toBe(true);
    expect(isScanDenied(markScanDenied(pending, 'expired', 'x', T0))).toBe(true);
  });

  it('isScanTerminal covers consumed/denied/revoked/expired/overridden but not pending', () => {
    expect(isScanTerminal(createScanLedger(input()))).toBe(false);
    expect(isScanTerminal(markScanConsumed(createScanLedger(input()), T0))).toBe(true);
    expect(isScanTerminal(markScanDenied(createScanLedger(input()), 'expired', 'x', T0))).toBe(
      true,
    );
    const overridden = overrideScan(
      markScanDenied(createScanLedger(input()), 'already_used', 'x', T0),
      'staff_2',
      'reason',
      T0,
    );
    expect(isScanTerminal(overridden)).toBe(true);
  });

  it('isScanDeniedFor matches status AND reason together', () => {
    const denied = markScanDenied(createScanLedger(input()), 'expired', 'x', T0);
    expect(isScanDeniedFor(denied, 'expired')).toBe(true);
    expect(isScanDeniedFor(denied, 'already_used')).toBe(false);
  });
});
