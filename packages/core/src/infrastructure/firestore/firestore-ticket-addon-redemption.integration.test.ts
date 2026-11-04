import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';

import { FirestoreEntitlementRepository } from './firestore-entitlement-repository.js';

import type { Entitlement } from '../../domain/models/entitlement.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('Firestore ticket add-on redemption', () => {
  it('serializes concurrent redemption and writes one outbox fact without consuming admission', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const suffix = randomUUID();
    const eventId = `addon-redeem-event-${suffix}`;
    const entitlementId = `addon-redeem-ticket-${suffix}`;
    const addonEntitlementId = `addon-redeem-grant-${suffix}`;
    const addonId = `addon-redeem-sku-${suffix}`;
    const organizationId = `addon-redeem-org-${suffix}`;
    const now = new Date();
    const entitlement: Entitlement = {
      id: entitlementId,
      orderId: `addon-redeem-order-${suffix}`,
      eventId,
      organizationId,
      tierId: `addon-redeem-tier-${suffix}`,
      tierName: 'General',
      userId: `addon-redeem-user-${suffix}`,
      currentHolderUserId: `addon-redeem-user-${suffix}`,
      credentialVersion: 1,
      holderName: 'Disposable Guest',
      status: 'valid',
      scanCountAllowed: 1,
      scanCount: 0,
      scannedAt: [],
      refundLock: null,
      ticketAddons: [
        {
          id: addonEntitlementId,
          addonId,
          name: 'Parking pass',
          kind: 'parking',
          unitPricePaise: 5000,
          status: 'active',
          createdAt: now.toISOString(),
          redeemedAt: null,
        },
      ],
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const event = domainEvent({
      id: deterministicDomainEventId('ticket.addon.redeemed', entitlementId, addonEntitlementId),
      type: 'ticket.addon.redeemed',
      aggregateId: entitlementId,
      organizationId,
      actorId: `addon-redeem-scanner-${suffix}`,
      payload: { entitlementId, addonEntitlementId, addonId, eventId },
      occurredAt: now.getTime(),
    });
    const repository = new FirestoreEntitlementRepository(db);

    try {
      await repository.saveMany([entitlement]);
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          repository.redeemTicketAddon({ entitlementId, addonEntitlementId, eventId, now }, event),
        ),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
        results
          .map((result) =>
            result.status === 'rejected'
              ? result.reason instanceof Error
                ? result.reason.message
                : String(result.reason)
              : result.status,
          )
          .join('; '),
      ).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await repository.getById(entitlementId)).toMatchObject({
        status: 'valid',
        scanCount: 0,
        ticketAddons: [
          { id: addonEntitlementId, status: 'redeemed', redeemedAt: now.toISOString() },
        ],
      });
      const outbox = await db.collection('v2_outbox').doc(event.id).get();
      expect(outbox.exists).toBe(true);
    } finally {
      await db.collection('v2_entitlements').doc(entitlementId).delete();
      await db.collection('v2_outbox').doc(event.id).delete();
      await db.terminate();
    }
  }, 30_000);
});
