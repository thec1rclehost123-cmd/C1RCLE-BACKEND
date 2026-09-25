import { describe, expect, it } from 'vitest';

import { createCoverWallet } from './models/cover-wallet.js';
import { issueEntitlements } from './models/entitlement.js';
import { createEventCode, createScannerSession } from './models/event-code.js';
import { createScanLedger } from './models/scan-ledger.js';
import { scannerDeviceId } from './models/scanner-device.js';

import type { Order } from './models/order.js';

/**
 * ─── Every minted id fits the wire ──────────────────────────────────────────
 *
 * `opaqueIdSchema` caps ids at 64 characters and rejects anything outside
 * `[A-Za-z0-9][A-Za-z0-9_-]*`. Any id that breaks either rule fails response
 * validation, which surfaces to the caller as a 500 — long after the write
 * succeeded.
 *
 * This repo has now shipped that exact bug **three separate times**:
 * `entitlementId`, `scanLedgerId` and `scannerDeviceId` each started life as a
 * readable composite like `PREFIX-${aId}-${bId}-${timestamp}`, each was fine
 * against test fixtures, and each overflowed the moment real UUIDs arrived.
 * `scannerDeviceId` shipped to a front-end team and broke `POST /door/devices`
 * with a 500.
 *
 * The common thread is the *fixtures*: `org_1`, `evt_1`, `tier_1` are five
 * characters where production has thirty-six, so a composite id can be twice
 * the legal length and every test still passes. This file exists to remove
 * that blind spot — it feeds every id-minting function inputs the size of real
 * ones, and fails if the result could not be sent back.
 *
 * **If you add a function that mints an id, add it here.**
 */

/** Deliberately the worst realistic case, not a friendly one. */
const UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const LONG_ORG = UUID;
const LONG_EVENT = UUID;
const LONG_USER = UUID;
/** `deviceId` is `min(16).max(128)` on the wire — so 128 is a legal input. */
const LONG_DEVICE = 'scanner_'.padEnd(128, 'a');
/** Razorpay-shaped order id, which is what broke `entitlementId` originally. */
const LONG_ORDER = `ORD-pay_${'N7xEuCGNlZTbcr'.padEnd(30, 'x')}`;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function expectUsableAsOpaqueId(id: string, label: string): void {
  expect(id.length, `${label} is ${String(id.length)} chars — the cap is 64`).toBeLessThanOrEqual(
    64,
  );
  expect(id, `${label} contains characters opaqueIdSchema rejects`).toMatch(OPAQUE_ID);
}

describe('every minted id survives production-sized inputs', () => {
  it('scannerDeviceId — a UUID org plus a 128-char device id', () => {
    // The regression: this was `${organizationId}_${deviceId}`, which reached
    // ~165 characters here and 500'd every device registration.
    expectUsableAsOpaqueId(scannerDeviceId(LONG_ORG, LONG_DEVICE), 'scannerDeviceId');
  });

  it('scannerDeviceId stays deterministic — findByDevice reconstructs it', () => {
    expect(scannerDeviceId(LONG_ORG, LONG_DEVICE)).toBe(scannerDeviceId(LONG_ORG, LONG_DEVICE));
    // And stays scoped to one tenant: the same handset at another club is a
    // different, unbound device there.
    expect(scannerDeviceId(LONG_ORG, LONG_DEVICE)).not.toBe(
      scannerDeviceId('other-org-uuid-here-0000', LONG_DEVICE),
    );
  });

  it('cover wallet id — UUID event and UUID user', () => {
    const wallet = createCoverWallet({
      userId: LONG_USER,
      eventId: LONG_EVENT,
      organizationId: LONG_ORG,
      venueId: null,
      openingBalance: 100_000,
    });
    expectUsableAsOpaqueId(wallet.id, 'coverWallet.id');
  });

  it('cover wallet ids do not collide inside one millisecond', () => {
    const input = {
      userId: LONG_USER,
      eventId: LONG_EVENT,
      organizationId: LONG_ORG,
      venueId: null,
      openingBalance: 100_000,
      now: new Date('2026-09-18T20:00:00.000Z'),
    };
    const ids = new Set(Array.from({ length: 50 }, () => createCoverWallet(input).id));
    expect(ids.size).toBe(50);
  });

  it('scan ledger id — UUID event and a hashed entitlement id', () => {
    const scan = createScanLedger({
      eventId: LONG_EVENT,
      organizationId: LONG_ORG,
      venueId: LONG_EVENT,
      entitlementId: `ENT-${'a'.repeat(32)}`,
      doorSaleId: null,
      entryType: 'ticket',
      tierName: 'General',
      tierId: UUID,
      operatorUid: LONG_USER,
      operatorName: null,
      operatorRole: null,
      gate: null,
      deviceId: LONG_DEVICE,
      deviceName: null,
      deviceBound: true,
      guestName: null,
      guestEmail: null,
      guestPhone: null,
      scannedAt: new Date().toISOString(),
      admittedCount: 1,
      scanCountUsed: 1,
      scanCountAllowed: 1,
      isOffline: false,
      offlineDeviceId: null,
    });
    expectUsableAsOpaqueId(scan.id, 'scanLedger.id');
  });

  it('entitlement id — a provider-shaped order id and a UUID tier', () => {
    const order = {
      id: LONG_ORDER,
      eventId: LONG_EVENT,
      organizationId: LONG_ORG,
      userId: LONG_USER,
      contact: { name: 'Ada Guest', email: 'ada@example.test', phone: '9876543210' },
      status: 'paid',
      lines: [
        { tierId: UUID, tierName: 'General', unitPricePaise: 100, quantity: 2, subtotalPaise: 200 },
      ],
    } as unknown as Order;

    for (const entitlement of issueEntitlements({ order })) {
      expectUsableAsOpaqueId(entitlement.id, 'entitlement.id');
    }
  });

  it('event code and scanner session ids', () => {
    const code = createEventCode({
      eventId: LONG_EVENT,
      organizationId: LONG_ORG,
      venueId: LONG_EVENT,
      type: 'full',
      gate: null,
      createdBy: LONG_USER,
      createdByName: 'Staff',
      expiresAt: null,
    });
    expectUsableAsOpaqueId(code.id, 'eventCode.id');
    // The human code is typed by staff, not used as an id, but it still
    // travels as a string on the wire.
    expect(code.code).toMatch(/^C1R-[A-Z0-9]{8}$/);

    const { session } = createScannerSession({
      codeId: code.id,
      organizationId: LONG_ORG,
      codeData: {
        id: code.id,
        code: code.code,
        eventId: LONG_EVENT,
        venueId: null,
        type: 'full',
        gate: null,
        maxDevices: 5,
        allowReuse: false,
      },
      deviceId: LONG_DEVICE,
      deviceName: 'Gate iPad',
      createdBy: LONG_USER,
      createdByName: 'Staff',
      sessionType: 'staff',
    });
    expectUsableAsOpaqueId(session.id, 'scannerSession.id');
  });
});
