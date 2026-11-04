import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import {
  beginRefundExecution,
  createRefundRequest,
  markRefundExecutionUncertain,
  recordRefundProviderFact,
} from '../../domain/models/refund-request.js';

import { FirestoreRefundRequestRepository } from './firestore-refund-request-repository.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(emulator)('uncertain refund recovery persistence (local Emulator)', () => {
  it('persists recovered facts across reload and rejects a competing stale recovery', async () => {
    if (!emulator || !/^(127\.0\.0\.1|localhost):\d+$/.test(emulator)) {
      throw new Error('Refund recovery test requires a loopback Firestore emulator');
    }
    const db = new Firestore({ projectId: 'c1rcle-v2', host: emulator, ssl: false });
    const repo = new FirestoreRefundRequestRepository(db);
    const id = `m2-refund-recovery-${randomUUID()}`;
    const now = new Date();
    try {
      const request = createRefundRequest({
        id,
        orderId: `order-${id}`,
        organizationId: `org-${id}`,
        amountPaise: 1000,
        requestedBy: 'synthetic-admin',
        reason: 'Synthetic local recovery',
        hasRedeemedEntitlement: false,
        now,
      });
      await repo.save(request);
      const executing = beginRefundExecution(request, now);
      await repo.save(executing);
      const uncertain = markRefundExecutionUncertain(executing, 'Synthetic timeout', now);
      await repo.save(uncertain);
      const results = await Promise.allSettled([
        repo.save(recordRefundProviderFact(uncertain, 'rfnd_candidate_a', 'processed', now)),
        repo.save(recordRefundProviderFact(uncertain, 'rfnd_candidate_b', 'pending', now)),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({
        code: 'version_conflict',
      });
      const stored = await new FirestoreRefundRequestRepository(db).getById(id);
      const winner =
        results[0]?.status === 'fulfilled'
          ? ['rfnd_candidate_a', 'processed']
          : ['rfnd_candidate_b', 'pending'];
      expect(stored).toMatchObject({
        status: 'executing',
        providerRefundId: winner[0],
        providerStatus: winner[1],
        executionIdempotencyKey: uncertain.executionIdempotencyKey,
        executionAttempts: 1,
        version: uncertain.version + 1,
      });
    } finally {
      await db.collection('v2_refund_requests').doc(id).delete();
      await db.terminate();
    }
  }, 30_000);
});
