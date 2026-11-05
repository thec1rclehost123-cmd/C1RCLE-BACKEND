import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { AdminAuthorityService } from '../../application/admin/admin-authority-service.js';
import { createCoreConfig } from '../../config/index.js';
import { createPlatformAdmin } from '../../domain/models/admin-authority.js';
import {
  beginRefundExecution,
  createRefundRequest,
  markRefundExecutionUncertain,
  recordRefundProviderFact,
} from '../../domain/models/refund-request.js';

import { FirestoreAdminAuditRepository } from './firestore-onboarding-repository.js';
import { FirestoreRefundRequestRepository } from './firestore-refund-request-repository.js';

import type { ServiceDeps } from '../../application/context.js';
import type { AuditRequestMeta } from '../../domain/ports/audit.js';

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

describe.runIf(emulator)('Admin authority audit optional metadata (local Emulator)', () => {
  it.each<{ label: string; meta: AuditRequestMeta }>([
    { label: 'absent', meta: {} },
    {
      label: 'both supplied',
      meta: { ipAddress: '127.0.0.1', userAgent: 'synthetic-native-audit' },
    },
    { label: 'IP only', meta: { ipAddress: '127.0.0.1' } },
    { label: 'User-Agent only', meta: { userAgent: 'synthetic-native-audit' } },
    { label: 'supplied empty strings', meta: { ipAddress: '', userAgent: '' } },
  ])(
    'persists $label without undefined fields and preserves append-only actor evidence',
    async ({ meta }) => {
      if (!emulator || !/^(127\.0\.0\.1|localhost):\d+$/.test(emulator)) {
        throw new Error('Audit metadata regression requires a loopback Firestore emulator');
      }
      const projectId = `demo-m4-audit-${randomUUID().slice(0, 8)}`;
      const db = new Firestore({ projectId, host: emulator, ssl: false });
      const audit = new FirestoreAdminAuditRepository(db);
      const now = new Date('2026-11-04T12:00:00.000Z');
      const id = `AUDIT-${randomUUID()}`;
      const config = createCoreConfig({
        redis: { url: 'redis://127.0.0.1:6381/4' },
        firestore: { projectId },
        clock: { now: () => now },
        ids: () => id,
      });
      const authority = new AdminAuthorityService({
        config,
        adminAudit: audit,
      } as unknown as ServiceDeps);
      const admin = createPlatformAdmin({
        id: 'ADMIN-synthetic-native',
        email: 'synthetic-audit@example.test',
        role: 'finance',
        now,
      });
      const input = {
        action: 'finance.refund.requested',
        targetType: 'refund_request',
        targetId: 'REF-synthetic-native',
        before: null,
        after: { status: 'pending' },
        ...meta,
      };
      try {
        await authority.record(admin, input);
        const record = (await db.collection('v2_admin_audit_logs').doc(id).get()).data();
        expect(record).toEqual({
          id,
          adminId: admin.id,
          adminRole: admin.role,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          before: input.before,
          after: input.after,
          reason: null,
          occurredAt: now.getTime(),
          ...meta,
        });
        expect(Object.hasOwn(record ?? {}, 'ipAddress')).toBe(meta.ipAddress !== undefined);
        expect(Object.hasOwn(record ?? {}, 'userAgent')).toBe(meta.userAgent !== undefined);
        await authority.record(
          { ...admin, id: 'ADMIN-different', role: 'super' },
          {
            ...input,
            after: { status: 'changed' },
            reason: 'A duplicate must not rewrite original evidence',
          },
        );
        expect((await db.collection('v2_admin_audit_logs').doc(id).get()).data()).toEqual(record);
      } finally {
        await db.recursiveDelete(db.collection('v2_admin_audit_logs'));
        await db.terminate();
      }
    },
    30_000,
  );
});
