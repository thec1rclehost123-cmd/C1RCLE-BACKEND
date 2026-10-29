import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { freezeEntitlementForRefund } from '../../domain/models/entitlement.js';

import { FirestoreEntitlementRepository } from './firestore-entitlement-repository.js';

import type { Entitlement } from '../../domain/models/entitlement.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('Firestore refund and admission race', () => {
  it('serializes refund freeze against scanner admission so exactly one wins', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const suffix = randomUUID();
    const eventId = `refund-scan-event-${suffix}`;
    const entitlementId = `refund-scan-ticket-${suffix}`;
    const refundRequestId = `refund-scan-request-${suffix}`;
    const now = new Date();
    const entitlement: Entitlement = {
      id: entitlementId,
      orderId: `refund-scan-order-${suffix}`,
      eventId,
      organizationId: `refund-scan-org-${suffix}`,
      tierId: `refund-scan-tier-${suffix}`,
      tierName: 'General',
      userId: `refund-scan-user-${suffix}`,
      currentHolderUserId: `refund-scan-user-${suffix}`,
      credentialVersion: 1,
      holderName: 'Disposable Guest',
      status: 'valid',
      scanCountAllowed: 1,
      scanCount: 0,
      scannedAt: [],
      refundLock: null,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const repository = new FirestoreEntitlementRepository(db);

    try {
      await repository.saveMany([entitlement]);
      const frozen = freezeEntitlementForRefund(entitlement, refundRequestId, now);
      const [freezeResult, admissionResult] = await Promise.allSettled([
        repository.save(frozen),
        repository.claimAdmission(entitlementId, eventId),
      ]);
      const refundWon = freezeResult.status === 'fulfilled';
      const admissionWon = admissionResult.status === 'fulfilled' && admissionResult.value.admitted;

      expect(Number(refundWon) + Number(admissionWon)).toBe(1);
      const stored = await repository.getById(entitlementId);
      expect(stored).not.toBeNull();
      if (refundWon) {
        expect(stored).toMatchObject({ refundLock: { refundRequestId }, scanCount: 0 });
      } else {
        expect(stored).toMatchObject({ refundLock: null, scanCount: 1 });
      }
    } finally {
      await db.collection('v2_entitlements').doc(entitlementId).delete();
      await db.terminate();
    }
  }, 30_000);
});
