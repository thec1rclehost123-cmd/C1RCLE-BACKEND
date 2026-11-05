import { describe, expect, it, vi } from 'vitest';

import { ConflictError, NotFoundError } from '../../domain/errors.js';
import { createEvent } from '../../domain/models/event.js';

import { createScannerService } from './scanner-service.js';

import type { ScannerServiceDeps } from './scanner-service.js';
import type { Entitlement } from '../../domain/models/entitlement.js';
import type { Event } from '../../domain/models/event.js';
import type { ActorContext } from '../context.js';

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

const NOW = new Date('2026-11-04T20:00:00.000Z');
const EVENT = {
  ...createEvent({
    id: 'EVT-1',
    organizationId: 'ORG-1',
    venueId: 'VEN-1',
    title: 'Night',
    startAt: '2026-11-05T20:00:00.000Z',
  }),
  status: 'published' as const,
};
function serviceFor(
  entitlement: Entitlement | null,
  event: Event = EVENT,
  completion?: 'pending' | 'complete' | null,
) {
  const findById = vi.fn(async () => entitlement);
  const deps = {
    scanLedger: {},
    eventCodes: {},
    scannerSessions: {},
    scannerDevices: {},
    entitlements: { findById },
    repositories: {
      events: { findById: vi.fn(async () => event) },
      orders: {
        getById: vi.fn(async () =>
          completion
            ? {
                id: entitlement?.orderId,
                eventId: entitlement?.eventId,
                organizationId: entitlement?.organizationId,
                fulfillmentState: completion,
              }
            : null,
        ),
      },
    },
    config: {
      magicTicketSecret: 'test-only-secret-not-used-as-a-real-key',
      clock: { now: () => NOW },
    },
    logger: {},
    outbox: {},
    adminAudit: {},
  } as unknown as ScannerServiceDeps;

  return { scanner: createScannerService(deps), findById };
}

describe('generateMagicTicketQr', () => {
  it.each([null, 'pending'] as const)(
    'fails closed for completion-required ticket with %s order completion',
    async (completion) => {
      const { scanner } = serviceFor(
        { ...BASE_ENTITLEMENT, fulfillmentRequired: true },
        EVENT,
        completion,
      );
      await expect(scanner.generateMagicTicketQr(BASE_ENTITLEMENT.id, HOLDER)).rejects.toThrow(
        /processing/,
      );
    },
  );
  it('permits QR presentation after canonical paid completion', async () => {
    const { scanner } = serviceFor(
      { ...BASE_ENTITLEMENT, fulfillmentRequired: true },
      EVENT,
      'complete',
    );
    await expect(scanner.generateMagicTicketQr(BASE_ENTITLEMENT.id, HOLDER)).resolves.toMatchObject(
      { refreshIntervalSec: 30 },
    );
  });

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

  it('binds an assigned ticket QR to its current holder and rotates by credential version', async () => {
    const transferred = {
      ...BASE_ENTITLEMENT,
      currentHolderUserId: 'guest-2',
      credentialVersion: 2,
    };
    const { scanner } = serviceFor(transferred);
    const recipient = { ...HOLDER, userId: 'guest-2' };

    await expect(scanner.generateMagicTicketQr(transferred.id, recipient)).resolves.toMatchObject({
      qrPayload: expect.stringMatching(/^ENT-1:2:\d+:\w+$/),
    });
    await expect(scanner.generateMagicTicketQr(transferred.id, HOLDER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('M3 authoritative QR gates', () => {
  it('does not mint an explicitly unassigned QR for the purchaser or tenant staff', async () => {
    const { scanner } = serviceFor({ ...BASE_ENTITLEMENT, currentHolderUserId: null });
    await expect(scanner.generateMagicTicketQr('ENT-1', HOLDER)).rejects.toThrow();
    await expect(
      scanner.generateMagicTicketQr('ENT-1', { ...HOLDER, organizationId: 'ORG-1' }),
    ).rejects.toThrow();
  });
  it('withholds credentials more than 24 hours before the current event start', async () => {
    const { scanner } = serviceFor(BASE_ENTITLEMENT, {
      ...EVENT,
      startAt: '2026-11-05T20:00:00.001Z',
    });
    await expect(scanner.generateMagicTicketQr('ENT-1', HOLDER)).rejects.toThrow();
  });
  it.each(['cancelled', 'postponed'] as const)(
    'withholds credentials for %s events',
    async (status) => {
      const { scanner } = serviceFor(BASE_ENTITLEMENT, { ...EVENT, status });
      await expect(scanner.generateMagicTicketQr('ENT-1', HOLDER)).rejects.toThrow();
    },
  );
});
