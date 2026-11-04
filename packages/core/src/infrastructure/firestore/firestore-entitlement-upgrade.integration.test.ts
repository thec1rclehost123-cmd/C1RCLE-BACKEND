import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { freezeEntitlementForRefund } from '../../domain/models/entitlement.js';

import { FirestoreEntitlementRepository } from './firestore-entitlement-repository.js';

import type { Entitlement } from '../../domain/models/entitlement.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('ticket upgrade swap (Firestore emulator)', () => {
  it('atomically races scanner admission against replacement activation', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repository = new FirestoreEntitlementRepository(db);
    const suffix = randomUUID();
    const now = new Date();
    const source: Entitlement = {
      id: `ENT-upgrade-source-${suffix}`,
      orderId: `ORD-source-${suffix}`,
      eventId: `EVT-${suffix}`,
      organizationId: `ORG-${suffix}`,
      tierId: `TIER-general-${suffix}`,
      tierName: 'General Admission',
      userId: `USR-${suffix}`,
      currentHolderUserId: `USR-${suffix}`,
      unitKind: 'paid',
      holderName: 'Guest',
      status: 'valid',
      scanCountAllowed: 1,
      scanCount: 0,
      scannedAt: [],
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const replacement: Entitlement = {
      ...source,
      id: `ENT-upgrade-replacement-${suffix}`,
      orderId: `ORD-upgrade-${suffix}`,
      tierId: `TIER-premium-${suffix}`,
      tierName: 'Premium Admission',
      upgradeFromEntitlementId: source.id,
    };
    const refs = [source.id, replacement.id].map((id) => db.collection('v2_entitlements').doc(id));

    try {
      await repository.save(source);
      const [swapResult, admissionResult] = await Promise.allSettled([
        repository.replaceForUpgrade({
          sourceEntitlementId: source.id,
          expectedSourceVersion: source.version,
          replacement,
          now,
        }),
        repository.claimAdmission(source.id, source.eventId, { now }),
      ]);

      const storedSource = await repository.getById(source.id);
      const storedReplacement = await repository.getById(replacement.id);
      if (swapResult.status === 'fulfilled') {
        expect(admissionResult).toMatchObject({
          status: 'fulfilled',
          value: { admitted: false },
        });
        expect(storedSource).toMatchObject({
          status: 'void',
          upgradedToEntitlementId: replacement.id,
        });
        expect(storedReplacement?.status).toBe('valid');
      } else {
        expect(admissionResult).toMatchObject({
          status: 'fulfilled',
          value: { admitted: true },
        });
        expect(storedSource?.status).toBe('redeemed');
        expect(storedReplacement).toBeNull();
      }
    } finally {
      const batch = db.batch();
      for (const ref of refs) batch.delete(ref);
      await batch.commit();
      await db.terminate();
    }
  });

  it('atomically restores an untouched source after the full refund and converges on retry', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repository = new FirestoreEntitlementRepository(db);
    const suffix = randomUUID();
    const now = new Date();
    const source: Entitlement = {
      id: `ENT-refund-source-${suffix}`,
      orderId: `ORD-source-${suffix}`,
      eventId: `EVT-${suffix}`,
      organizationId: `ORG-${suffix}`,
      tierId: `TIER-general-${suffix}`,
      tierName: 'General Admission',
      userId: `USR-${suffix}`,
      currentHolderUserId: `USR-${suffix}`,
      unitKind: 'paid',
      holderName: 'Guest',
      status: 'valid',
      scanCountAllowed: 1,
      scanCount: 0,
      scannedAt: [],
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const replacement: Entitlement = {
      ...source,
      id: `ENT-refund-replacement-${suffix}`,
      orderId: `ORD-upgrade-${suffix}`,
      tierId: `TIER-premium-${suffix}`,
      tierName: 'Premium Admission',
      upgradeFromEntitlementId: source.id,
    };
    const refundRequestId = `REF-${suffix}`;
    const refs = [source.id, replacement.id].map((id) => db.collection('v2_entitlements').doc(id));

    try {
      await repository.save(source);
      const swapped = await repository.replaceForUpgrade({
        sourceEntitlementId: source.id,
        expectedSourceVersion: source.version,
        replacement,
        now,
      });
      await repository.save(freezeEntitlementForRefund(swapped.replacement, refundRequestId, now));
      const first = await repository.restoreForUpgradeRefund({
        sourceEntitlementId: source.id,
        replacementEntitlementId: replacement.id,
        refundRequestId,
        now,
      });
      const replay = await repository.restoreForUpgradeRefund({
        sourceEntitlementId: source.id,
        replacementEntitlementId: replacement.id,
        refundRequestId,
        now,
      });

      expect(first.source).toMatchObject({
        status: 'valid',
        upgradeRefundRequestId: refundRequestId,
      });
      expect(first.replacement).toMatchObject({ status: 'void', refundLock: null });
      expect(replay.source.version).toBe(first.source.version);
      expect(replay.replacement.version).toBe(first.replacement.version);
    } finally {
      const batch = db.batch();
      for (const ref of refs) batch.delete(ref);
      await batch.commit();
      await db.terminate();
    }
  });
});
