import { describe, expect, it } from 'vitest';

import { MemoryEntitlementRepository } from '../infrastructure/memory/memory-repositories.js';

import { ConflictError, NotFoundError } from './errors.js';
import { createTicketTransfer } from './models/ticket-transfer.js';

import type { Entitlement } from './models/entitlement.js';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const TICKET: Entitlement = {
  id: 'ENT-transfer-1',
  orderId: 'ORD-purchase-1',
  eventId: 'EVT-transfer-1',
  organizationId: 'ORG-venue-1',
  tierId: 'TIER-general-1',
  tierName: 'General',
  userId: 'USR-sender-1',
  currentHolderUserId: 'USR-sender-1',
  credentialVersion: 1,
  pendingTransferId: null,
  holderName: 'Sender Guest',
  status: 'valid',
  scanCountAllowed: 1,
  scanCount: 0,
  scannedAt: [],
  refundLock: null,
  version: 1,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

function transfer(id = 'TRF-1') {
  return createTicketTransfer({
    id,
    entitlementId: TICKET.id,
    eventId: TICKET.eventId,
    senderUserId: 'USR-sender-1',
    recipientUserId: 'USR-recipient-1',
    expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    now: NOW,
  });
}

describe('ticket transfer lifecycle', () => {
  it('keeps sender ownership pending and atomically rotates ownership on recipient acceptance', async () => {
    const repo = new MemoryEntitlementRepository();
    await repo.save(TICKET);
    await repo.createTicketTransfer(transfer(), 'USR-sender-1');

    expect(await repo.getById(TICKET.id)).toMatchObject({
      currentHolderUserId: 'USR-sender-1',
      pendingTransferId: 'TRF-1',
      credentialVersion: 1,
    });
    await expect(
      repo.resolveTicketTransfer({
        transferId: 'TRF-1',
        actorUserId: 'USR-sender-1',
        action: 'accept',
        holderName: 'Recipient',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const accepted = await repo.resolveTicketTransfer({
      transferId: 'TRF-1',
      actorUserId: 'USR-recipient-1',
      action: 'accept',
      holderName: 'Recipient Guest',
      now: new Date(NOW.getTime() + 1000),
    });
    expect(accepted.transfer.status).toBe('accepted');
    expect(accepted.entitlement).toMatchObject({
      userId: 'USR-sender-1',
      currentHolderUserId: 'USR-recipient-1',
      credentialVersion: 2,
      pendingTransferId: null,
      holderName: 'Recipient Guest',
    });
  });

  it('lets the purchaser transfer an unassigned group admission from custody', async () => {
    const repo = new MemoryEntitlementRepository();
    await repo.save({ ...TICKET, currentHolderUserId: null, holderName: '' });
    await repo.createTicketTransfer(transfer(), 'USR-sender-1');

    const accepted = await repo.resolveTicketTransfer({
      transferId: 'TRF-1',
      actorUserId: 'USR-recipient-1',
      action: 'accept',
      holderName: 'Recipient Guest',
      now: new Date(NOW.getTime() + 1000),
    });

    expect(accepted.entitlement).toMatchObject({
      userId: 'USR-sender-1',
      currentHolderUserId: 'USR-recipient-1',
      credentialVersion: 2,
      holderName: 'Recipient Guest',
    });
  });

  it('allows one pending transfer and supports sender cancellation without changing ownership', async () => {
    const repo = new MemoryEntitlementRepository();
    await repo.save(TICKET);
    await repo.createTicketTransfer(transfer(), 'USR-sender-1');
    await expect(
      repo.createTicketTransfer(transfer('TRF-2'), 'USR-sender-1'),
    ).rejects.toBeInstanceOf(ConflictError);

    const cancelled = await repo.resolveTicketTransfer({
      transferId: 'TRF-1',
      actorUserId: 'USR-sender-1',
      action: 'cancel',
      now: new Date(NOW.getTime() + 1000),
    });
    expect(cancelled.transfer.status).toBe('cancelled');
    expect(cancelled.entitlement).toMatchObject({
      currentHolderUserId: 'USR-sender-1',
      credentialVersion: 1,
      pendingTransferId: null,
    });
  });

  it('durably expires an overdue invitation and releases the pending lock', async () => {
    const repo = new MemoryEntitlementRepository();
    await repo.save(TICKET);
    await repo.createTicketTransfer(transfer(), 'USR-sender-1');
    const expired = await repo.resolveTicketTransfer({
      transferId: 'TRF-1',
      actorUserId: 'USR-recipient-1',
      action: 'accept',
      now: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
    });

    expect(expired.transfer.status).toBe('expired');
    expect(expired.entitlement.pendingTransferId).toBeNull();
  });
});
