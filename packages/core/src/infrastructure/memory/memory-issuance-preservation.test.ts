import { describe, expect, it } from 'vitest';

import { ConflictError, VersionConflictError } from '../../domain/errors.js';
import { domainEvent } from '../../domain/events.js';
import { newVersionedEntity } from '../../domain/identity.js';

import { MemoryEntitlementRepository } from './memory-repositories.js';

import type { Entitlement } from '../../domain/models/entitlement.js';

function fixture() {
  const initial: Entitlement = {
    ...newVersionedEntity(new Date('2026-11-05T12:00:00.000Z')),
    id: 'ENT-local',
    orderId: 'ORD-local',
    eventId: 'EVT-local',
    organizationId: 'ORG-local',
    tierId: 'TIER-local',
    tierName: 'General',
    userId: 'USR-purchaser',
    currentHolderUserId: 'USR-purchaser',
    unitKind: 'paid',
    credentialVersion: 1,
    holderName: 'Purchaser',
    status: 'valid',
    scanCountAllowed: 1,
    scanCount: 0,
    scannedAt: [],
    refundLock: null,
  };
  const issued = domainEvent({
    id: 'EVT-issued-local',
    type: 'ticket.issued',
    aggregateId: initial.id,
    organizationId: initial.organizationId,
    actorId: 'USR-purchaser',
    occurredAt: Date.parse(initial.createdAt),
    payload: {
      entitlementId: initial.id,
      orderId: initial.orderId,
      eventId: initial.eventId,
      purchaserUserId: initial.userId,
      holderUserId: initial.currentHolderUserId ?? null,
    },
  });
  return { initial, issued, repository: new MemoryEntitlementRepository() };
}

describe('Memory initial issuance retry parity', () => {
  it('replays initial issuance without resetting later custody, scans and refund locks', async () => {
    const f = fixture();
    await f.repository.save(f.initial, null, f.issued);
    await f.repository.save(f.initial, null, f.issued);
    const current: Entitlement = {
      ...f.initial,
      currentHolderUserId: 'USR-recipient',
      credentialVersion: 2,
      status: 'redeemed',
      scanCount: 1,
      scannedAt: [f.initial.updatedAt],
      refundLock: { refundRequestId: 'REF-local', frozenAt: f.initial.updatedAt },
      version: 2,
    };
    await f.repository.save(current);
    await f.repository.save(f.initial, null, f.issued);
    expect(await f.repository.getById(f.initial.id)).toEqual(current);
  });

  it.each(['stored', 'incoming'] as const)(
    'preserves advanced legacy tickets with missing %s unit kind',
    async (legacySide) => {
      const f = fixture();
      const current: Entitlement = {
        ...f.initial,
        version: 2,
        currentHolderUserId: 'USR-recipient',
        credentialVersion: 2,
        status: 'redeemed',
        scanCount: 1,
        scannedAt: [f.initial.updatedAt],
      };
      if (legacySide === 'stored') delete current.unitKind;
      await f.repository.save(f.initial);
      await f.repository.save(current);
      const retry = { ...f.initial };
      if (legacySide === 'incoming') delete retry.unitKind;
      await f.repository.save(retry, null, f.issued);
      expect(await f.repository.getById(f.initial.id)).toEqual(current);
    },
  );

  it('does not turn ordinary initial saves into silent overwrites', async () => {
    const f = fixture();
    await f.repository.save(f.initial);
    await expect(f.repository.save(f.initial)).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('rejects the same id reused for another order', async () => {
    const f = fixture();
    await f.repository.save(f.initial, null, f.issued);
    const other = { ...f.initial, orderId: 'ORD-other' };
    await expect(
      f.repository.save(other, null, {
        ...f.issued,
        payload: { ...f.issued.payload, orderId: other.orderId },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await f.repository.getById(f.initial.id)).toEqual(f.initial);
  });

  it('rejects an issuance event for a different ticket before persistence', async () => {
    const f = fixture();
    await expect(
      f.repository.save(f.initial, null, { ...f.issued, aggregateId: 'ENT-other' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await f.repository.getById(f.initial.id)).toBeNull();
  });
});
