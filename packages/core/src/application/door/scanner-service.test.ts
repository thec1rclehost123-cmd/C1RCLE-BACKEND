import { describe, expect, it, vi } from 'vitest';

import { ConflictError, NotFoundError } from '../../domain/errors.js';

import { createScannerService } from './scanner-service.js';

import type { Entitlement } from '../../domain/models/entitlement.js';
import type { ActorContext } from '../context.js';
import type { ScannerServiceDeps } from './scanner-service.js';

const HOLDER: ActorContext = {
  userId: 'guest-1',
  organizationId: '',
  role: 'member',
  capabilities: [],
};

const BASE_ENTITLEMENT: Entitlement = {
  id: 'ENT-1',
  orderId: 'ORD-1',
  eventId: 'EVT-1',
  organizationId: 'ORG-1',
  tierId: 'TIER-1',
  tierName: 'General Admission',
  userId: HOLDER.userId,
  holderName: 'Guest',
  status: 'valid',
  scanCountAllowed: 1,
  scanCount: 0,
  scannedAt: [],
  version: 1,
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
};

function serviceFor(entitlement: Entitlement | null) {
  const findById = vi.fn(async () => entitlement);
  const deps = {
    scanLedger: {},
    eventCodes: {},
    scannerSessions: {},
    scannerDevices: {},
    entitlements: { findById },
    repositories: {},
    config: { magicTicketSecret: 'test-only-secret-not-used-as-a-real-key' },
    logger: {},
    outbox: {},
    adminAudit: {},
  } as unknown as ScannerServiceDeps;

  return { scanner: createScannerService(deps), findById };
}

describe('generateMagicTicketQr', () => {
  it('mints a short-lived credential for the authorized active holder', async () => {
    const { scanner } = serviceFor(BASE_ENTITLEMENT);

    await expect(scanner.generateMagicTicketQr(BASE_ENTITLEMENT.id, HOLDER)).resolves.toMatchObject(
      {
        refreshIntervalSec: 30,
        qrPayload: expect.stringMatching(/^ENT-1:\d+:\w+$/),
      },
    );
  });

  it.each([
    ['void', { ...BASE_ENTITLEMENT, status: 'void' as const }],
    ['redeemed', { ...BASE_ENTITLEMENT, status: 'redeemed' as const, scanCount: 1 }],
    [
      'refund locked',
      {
        ...BASE_ENTITLEMENT,
        refundLock: { refundRequestId: 'REF-1', frozenAt: '2026-10-22T00:00:00.000Z' },
      },
    ],
    ['fully scanned despite active status', { ...BASE_ENTITLEMENT, scanCount: 1 }],
  ])('does not mint a QR for a %s entitlement', async (_label, entitlement) => {
    const { scanner } = serviceFor(entitlement);

    await expect(scanner.generateMagicTicketQr(entitlement.id, HOLDER)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('preserves the hidden not-found response for a stranger before checking ticket state', async () => {
    const voidEntitlement = { ...BASE_ENTITLEMENT, status: 'void' as const };
    const { scanner } = serviceFor(voidEntitlement);
    const stranger = { ...HOLDER, userId: 'guest-2', organizationId: 'ORG-2' };

    await expect(
      scanner.generateMagicTicketQr(voidEntitlement.id, stranger),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
