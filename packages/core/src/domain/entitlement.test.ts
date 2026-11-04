import { describe, expect, it } from 'vitest';

import { MemoryEntitlementRepository } from '../infrastructure/memory/memory-repositories.js';

import { InvalidOperationError } from './errors.js';
import {
  changeEntitlementHolder,
  currentEntitlementHolderId,
  entitlementCredentialVersion,
  admitSeats,
  freezeEntitlementForRefund,
  supersedeEntitlementForUpgrade,
} from './models/entitlement.js';

import type { Entitlement } from './models/entitlement.js';

const T0 = new Date('2026-10-28T12:00:00.000Z');

const ticket: Entitlement = {
  id: 'ENT-ticket-1',
  orderId: 'ORD-order-1',
  eventId: 'EVT-event-1',
  organizationId: 'ORG-venue-1',
  tierId: 'TIER-general-1',
  tierName: 'General Admission',
  userId: 'USR-purchaser-1',
  currentHolderUserId: 'USR-purchaser-1',
  credentialVersion: 1,
  holderName: 'Purchaser Guest',
  status: 'valid',
  scanCountAllowed: 1,
  scanCount: 0,
  scannedAt: [],
  refundLock: null,
  version: 1,
  createdAt: T0.toISOString(),
  updatedAt: T0.toISOString(),
};

describe('entitlement ownership', () => {
  it('keeps legacy tickets with no holder field assigned to their purchaser', () => {
    const legacy = { ...ticket, currentHolderUserId: undefined, credentialVersion: undefined };

    expect(currentEntitlementHolderId(legacy)).toBe(ticket.userId);
    expect(entitlementCredentialVersion(legacy)).toBe(1);
  });

  it('preserves an explicit unassigned state instead of falling back to the purchaser', () => {
    expect(currentEntitlementHolderId({ ...ticket, currentHolderUserId: null })).toBeNull();
  });

  it('changes the current holder without changing purchaser or financial order ownership', () => {
    const next = changeEntitlementHolder(ticket, {
      expectedCurrentHolderUserId: 'USR-purchaser-1',
      nextHolderUserId: 'USR-recipient-1',
      holderName: 'Recipient Guest',
      now: new Date('2026-10-28T12:05:00.000Z'),
    });

    expect(next).toMatchObject({
      orderId: ticket.orderId,
      userId: ticket.userId,
      currentHolderUserId: 'USR-recipient-1',
      credentialVersion: 2,
      holderName: 'Recipient Guest',
      version: 2,
      updatedAt: '2026-10-28T12:05:00.000Z',
    });
  });

  it.each([
    ['scanned', { scanCount: 1 }],
    ['refunded', { status: 'void' as const }],
    [
      'refund locked',
      { refundLock: { refundRequestId: 'REF-lock-1', frozenAt: T0.toISOString() } },
    ],
  ])('refuses a holder change for a %s ticket', (_state, overrides) => {
    expect(() =>
      changeEntitlementHolder(
        { ...ticket, ...overrides },
        {
          expectedCurrentHolderUserId: 'USR-purchaser-1',
          nextHolderUserId: 'USR-recipient-1',
          holderName: 'Recipient Guest',
          now: T0,
        },
      ),
    ).toThrow(InvalidOperationError);
  });

  it('rejects a stale owner and refuses an empty name for an assigned holder', () => {
    expect(() =>
      changeEntitlementHolder(ticket, {
        expectedCurrentHolderUserId: 'USR-stale-owner',
        nextHolderUserId: 'USR-recipient-1',
        holderName: 'Recipient Guest',
        now: T0,
      }),
    ).toThrow(/holder changed/);

    expect(() =>
      changeEntitlementHolder(ticket, {
        expectedCurrentHolderUserId: 'USR-purchaser-1',
        nextHolderUserId: 'USR-recipient-1',
        holderName: '   ',
        now: T0,
      }),
    ).toThrow(/named holder/);
  });
});

describe('paid ticket upgrade swap', () => {
  const replacement: Entitlement = {
    ...ticket,
    id: 'ENT-ticket-upgrade-1',
    orderId: 'ORD-upgrade-1',
    tierId: 'TIER-premium-1',
    tierName: 'Premium Admission',
    upgradeFromEntitlementId: ticket.id,
  };

  it('marks the prior unused paid ticket as superseded', () => {
    expect(supersedeEntitlementForUpgrade(ticket, replacement.id, T0)).toMatchObject({
      id: ticket.id,
      status: 'void',
      upgradedToEntitlementId: replacement.id,
      version: 2,
    });
  });

  it('refuses a source ticket that was already scanned', () => {
    expect(() =>
      supersedeEntitlementForUpgrade({ ...ticket, scanCount: 1 }, replacement.id, T0),
    ).toThrow(/unused/);
  });

  it('prevents admission after replacement and prevents replacement after admission', async () => {
    const repository = new MemoryEntitlementRepository();
    await repository.save(ticket);
    const storedSource = await repository.getById(ticket.id);
    if (!storedSource) throw new Error('Source ticket fixture was not stored');
    const upgraded = await repository.replaceForUpgrade({
      sourceEntitlementId: ticket.id,
      expectedSourceVersion: storedSource.version,
      replacement,
      now: T0,
    });
    expect(await repository.claimAdmission(ticket.id, ticket.eventId, { now: T0 })).toMatchObject({
      admitted: false,
    });
    expect(upgraded.source.upgradedToEntitlementId).toBe(replacement.id);
    expect((await repository.getById(replacement.id))?.status).toBe('valid');

    const secondRepository = new MemoryEntitlementRepository();
    await secondRepository.save(ticket);
    expect(
      await secondRepository.claimAdmission(ticket.id, ticket.eventId, { now: T0 }),
    ).toMatchObject({
      admitted: true,
    });
    await expect(
      secondRepository.replaceForUpgrade({
        sourceEntitlementId: ticket.id,
        expectedSourceVersion: ticket.version,
        replacement: { ...replacement, id: 'ENT-ticket-upgrade-2' },
        now: T0,
      }),
    ).rejects.toThrow(/Version conflict/);
  });

  it('atomically restores an untouched source pass after the full upgrade refund and replays safely', async () => {
    const repository = new MemoryEntitlementRepository();
    await repository.save(ticket);
    const upgraded = await repository.replaceForUpgrade({
      sourceEntitlementId: ticket.id,
      expectedSourceVersion: ticket.version,
      replacement,
      now: T0,
    });
    const refundRequestId = 'REF-upgrade-1';
    await repository.save(freezeEntitlementForRefund(upgraded.replacement, refundRequestId, T0));

    const restored = await repository.restoreForUpgradeRefund({
      sourceEntitlementId: ticket.id,
      replacementEntitlementId: replacement.id,
      refundRequestId,
      now: T0,
    });
    expect(restored.source).toMatchObject({
      status: 'valid',
      upgradedToEntitlementId: replacement.id,
      upgradeRefundRequestId: refundRequestId,
    });
    expect(restored.replacement).toMatchObject({ status: 'void', refundLock: null });

    const replay = await repository.restoreForUpgradeRefund({
      sourceEntitlementId: ticket.id,
      replacementEntitlementId: replacement.id,
      refundRequestId,
      now: T0,
    });
    expect(replay.source.version).toBe(restored.source.version);
    expect(replay.replacement.version).toBe(restored.replacement.version);
  });

  it('refuses to restore the source when the replacement was scanned or changed holders', async () => {
    const repository = new MemoryEntitlementRepository();
    await repository.save(ticket);
    const upgraded = await repository.replaceForUpgrade({
      sourceEntitlementId: ticket.id,
      expectedSourceVersion: ticket.version,
      replacement,
      now: T0,
    });
    const refundRequestId = 'REF-upgrade-2';
    await repository.save(
      freezeEntitlementForRefund(
        { ...upgraded.replacement, scanCount: 1, currentHolderUserId: 'USR-recipient-1' },
        refundRequestId,
        T0,
      ),
    );

    await expect(
      repository.restoreForUpgradeRefund({
        sourceEntitlementId: ticket.id,
        replacementEntitlementId: replacement.id,
        refundRequestId,
        now: T0,
      }),
    ).rejects.toThrow(/cannot be restored/);
    expect((await repository.getById(ticket.id))?.status).toBe('void');
    expect((await repository.getById(replacement.id))?.status).toBe('valid');
  });
});

describe('active paid unit allowance', () => {
  it('counts purchaser-owned paid admission seats but excludes RSVP, comps, and void tickets', async () => {
    const repository = new MemoryEntitlementRepository();
    await repository.saveMany([
      { ...ticket, id: 'ENT-paid-1' },
      { ...ticket, id: 'ENT-paid-2', status: 'redeemed', currentHolderUserId: 'USR-recipient-1' },
      { ...ticket, id: 'ENT-group-2', scanCountAllowed: 2 },
      { ...ticket, id: 'ENT-rsvp', orderId: 'RSVP-event-1', unitKind: 'free_rsvp' },
      { ...ticket, id: 'ENT-comp', unitKind: 'complimentary' },
      { ...ticket, id: 'ENT-void', status: 'void' },
      { ...ticket, id: 'ENT-other-event', eventId: 'EVT-event-2' },
      { ...ticket, id: 'ENT-other-buyer', userId: 'USR-other' },
    ]);

    await expect(
      repository.countActivePaidUnitsByUserAndEvent('USR-purchaser-1', 'EVT-event-1'),
    ).resolves.toBe(4);
  });

  it('infers pre-M5 RSVP classification from deterministic order ids', async () => {
    const repository = new MemoryEntitlementRepository();
    await repository.save({ ...ticket, id: 'ENT-legacy-rsvp', orderId: 'RSVP-legacy' });

    await expect(
      repository.countActivePaidUnitsByUserAndEvent('USR-purchaser-1', 'EVT-event-1'),
    ).resolves.toBe(0);
  });
});

describe('credential-version admission fence', () => {
  it('refuses an old credential in the same atomic decision that admits a seat', () => {
    const rotated = changeEntitlementHolder(ticket, {
      expectedCurrentHolderUserId: 'USR-purchaser-1',
      nextHolderUserId: 'USR-recipient-1',
      holderName: 'Recipient Guest',
      now: T0,
    });

    expect(admitSeats(rotated, rotated.eventId, { expectedCredentialVersion: 1 })).toMatchObject({
      admitted: false,
      denyReason: 'invalid_signature',
      scansUsed: 0,
    });
    expect(admitSeats(rotated, rotated.eventId, { expectedCredentialVersion: 2 })).toMatchObject({
      admitted: true,
      scansUsed: 1,
    });
  });
});
