import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import {
  createOnboardingRequest,
  updateOnboardingProfile,
} from '../../domain/models/onboarding.js';

import {
  FirestoreOnboardingRepository,
  FirestoreAdminAuditRepository,
} from './firestore-onboarding-repository.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
describe.runIf(host)('Partner review audit persistence (loopback Emulator)', () => {
  it('persists optional request metadata without undefined Firestore values', async () => {
    if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
      throw new Error('Loopback Emulator required');
    const db = new Firestore({ projectId: 'demo-c1rcle-pass3-tests', host, ssl: false });
    const id = randomUUID();
    try {
      const repo = new FirestoreAdminAuditRepository(db);
      await repo.append({
        id,
        adminId: 'synthetic-admin',
        action: 'onboarding.request_changes',
        targetId: 'synthetic-request',
        ipAddress: undefined,
        userAgent: undefined,
        occurredAt: Date.now(),
      });
      expect((await repo.listRecent(10)).find((item) => item.id === id)).toMatchObject({
        action: 'onboarding.request_changes',
      });
    } finally {
      await db.collection('v2_admin_audit_logs').doc(id).delete();
      await db.terminate();
    }
  });
  it.each(['host', 'venue', 'promoter'] as const)(
    'reloads private %s KYC sections without losing earlier progress',
    async (requestedType) => {
      if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
        throw new Error('Loopback Emulator required');
      const db = new Firestore({ projectId: 'demo-c1rcle-pass3-tests', host, ssl: false });
      const id = randomUUID();
      try {
        const repo = () => new FirestoreOnboardingRepository(db);
        const created = createOnboardingRequest({
          id,
          userId: `synthetic-${id}`,
          requestedType,
          plan: 'basic',
          profile: {
            legalName: 'Synthetic business',
            contactPerson: 'Synthetic Applicant',
            phone: '+919000000001',
            city: 'Pune',
            entityType: 'business',
          },
        });
        await repo().save(created);
        const business = updateOnboardingProfile((await repo().getById(id))!, {
          kyc: { business: { pan: 'ABCDE1234F', address: 'Synthetic acceptance address' } },
        });
        await repo().save(business);
        const signatory = updateOnboardingProfile((await repo().getById(id))!, {
          kyc: {
            signatory: {
              fullName: 'Synthetic Applicant',
              designation: 'director',
              email: 'synthetic@example.invalid',
              idType: 'passport',
              idNumber: 'P1234567',
              declared: true,
            },
          },
        });
        await repo().save(signatory);
        expect(await repo().findOpenForUser(created.userId)).toMatchObject({
          profile: {
            kyc: { business: { pan: 'ABCDE1234F' }, signatory: { idNumber: 'P1234567' } },
          },
        });
        expect(await repo().findOpenForUser('unrelated')).toBeNull();
      } finally {
        await db.collection('v2_onboarding_requests').doc(id).delete();
        await db.terminate();
      }
    },
  );
});
