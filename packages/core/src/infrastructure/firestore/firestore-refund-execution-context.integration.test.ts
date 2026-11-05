import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import {
  beginRefundExecution,
  createRefundRequest,
  markRefundSettled,
} from '../../domain/models/refund-request.js';

import { FirestoreRefundRequestRepository } from './firestore-refund-request-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
describe.runIf(EMULATOR)('Native refund execution attribution persistence', () => {
  it('roundtrips the private winning actor and stable settlement audit facts', async () => {
    if (!EMULATOR || !/^(127\.0\.0\.1|localhost):\d+$/.test(EMULATOR))
      throw new Error('Execution context test requires loopback Emulator');
    const db = new Firestore({ projectId: `demo-m4-ref-audit-${randomUUID().slice(0, 8)}` });
    const repo = new FirestoreRefundRequestRepository(db);
    const now = new Date('2026-11-04T12:00:00.000Z');
    const request = createRefundRequest({
      id: `REF-${randomUUID()}`,
      orderId: 'ORD-local',
      organizationId: 'ORG-local',
      amountPaise: 1000,
      requestedBy: 'ADMIN-requester',
      reason: 'Synthetic execution context',
      hasRedeemedEntitlement: false,
      now,
    });
    const executionActor = {
      adminId: 'ADMIN-executor',
      adminRole: 'finance' as const,
      source: 'execution_claim' as const,
      authorizedAt: now.toISOString(),
      ipAddress: '127.0.0.10',
      userAgent: 'synthetic-executor',
    };
    const settlementAudit = {
      requestStatusBefore: 'executing',
      orderStatusBefore: 'refund_requested',
      orderStatusAfter: 'refunded',
      occurredAt: now.getTime(),
    };
    try {
      await repo.save(request);
      const executing = { ...beginRefundExecution(request, now), executionActor };
      await repo.save(executing);
      expect(await new FirestoreRefundRequestRepository(db).getById(request.id)).toMatchObject({
        executionActor,
      });
      await repo.save({ ...markRefundSettled(executing, 'rfnd-local', now), settlementAudit });
      expect(await new FirestoreRefundRequestRepository(db).getById(request.id)).toMatchObject({
        status: 'settled',
        executionActor,
        settlementAudit,
      });
    } finally {
      await db.recursiveDelete(db.collection('v2_refund_requests'));
      await db.terminate();
    }
  });
});
