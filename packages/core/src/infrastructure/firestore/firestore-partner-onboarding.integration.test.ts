import { createHash, randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import {
  createOnboardingRequest,
  updateOnboardingProfile,
} from '../../domain/models/onboarding.js';
import {
  hasCurrentPromoterAgreementAcceptance,
  recordPromoterAgreementAcceptance,
} from '../../domain/models/promoter-agreement.js';

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
  it('persists versioned staging acceptance and retains it after a new version', async () => {
    if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
      throw new Error('Loopback Emulator required');
    const db = new Firestore({ projectId: 'demo-c1rcle-pass3-tests', host, ssl: false });
    const id = randomUUID();
    const repo = new FirestoreOnboardingRepository(db);
    const text = 'C1RCLE STAGING PROMOTER AGREEMENT — FOR TESTING ONLY';
    const artifact = {
      version: 'staging-v1',
      status: 'staging_only' as const,
      text,
      textSha256: createHash('sha256').update(text).digest('hex'),
    };
    try {
      const created = createOnboardingRequest({
        id,
        userId: `synthetic-${id}`,
        requestedType: 'promoter',
        plan: 'basic',
        profile: {
          legalName: 'Synthetic',
          contactPerson: 'Synthetic',
          phone: '+919000000001',
          city: 'Pune',
        },
      });
      await repo.save(created);
      const accepted = recordPromoterAgreementAcceptance(
        created,
        artifact,
        created.userId,
        new Date(),
        false,
      );
      await repo.save(accepted);
      const reloaded = await new FirestoreOnboardingRepository(db).getById(id);
      expect(reloaded).not.toBeNull();
      expect(hasCurrentPromoterAgreementAcceptance(reloaded, artifact, false)).toBe(true);
      const next = { ...artifact, version: 'staging-v2' };
      expect(hasCurrentPromoterAgreementAcceptance(reloaded, next, false)).toBe(false);
      const renewed = recordPromoterAgreementAcceptance(
        reloaded!,
        next,
        created.userId,
        new Date(),
        false,
      );
      await repo.save(renewed);
      expect((await repo.getById(id))?.promoterAgreementAcceptances).toHaveLength(2);
    } finally {
      await db.collection('v2_onboarding_requests').doc(id).delete();
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
