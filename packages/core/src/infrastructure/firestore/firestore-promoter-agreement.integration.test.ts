import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { createOnboardingRequest } from '../../domain/models/onboarding.js';
import {
  PROMOTER_AGREEMENT_TEST_FIXTURE,
  recordPromoterAgreementAcceptance,
} from '../../domain/models/promoter-agreement.js';

import { FirestoreOnboardingRepository } from './firestore-onboarding-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('Promoter agreement evidence (Firestore emulator)', () => {
  it('persists acceptance version, text hash, actor, timestamp, and future reacceptance', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repository = new FirestoreOnboardingRepository(db);
    const run = randomUUID();
    const now = new Date('2026-10-28T12:00:00.000Z');
    const initial = createOnboardingRequest({
      id: `m4-test-onboarding-${run}`,
      userId: `m4-test-user-${run}`,
      requestedType: 'promoter',
      plan: 'basic',
      profile: {
        legalName: 'M4 Emulator Promoter',
        contactPerson: 'M4 Test',
        phone: '+910000000000',
        city: 'Pune',
      },
      now,
    });

    await repository.save(initial);
    const accepted = recordPromoterAgreementAcceptance(
      initial,
      PROMOTER_AGREEMENT_TEST_FIXTURE,
      initial.userId,
      now,
      true,
    );
    await repository.save(accepted);

    const fetched = await repository.getById(initial.id);
    expect(fetched?.promoterAgreementAcceptances).toEqual([
      {
        version: PROMOTER_AGREEMENT_TEST_FIXTURE.version,
        artifactStatus: 'test_fixture',
        textSha256: PROMOTER_AGREEMENT_TEST_FIXTURE.textSha256,
        acceptedBy: initial.userId,
        acceptedAt: now.toISOString(),
      },
    ]);

    const futureArtifact = {
      ...PROMOTER_AGREEMENT_TEST_FIXTURE,
      version: `${PROMOTER_AGREEMENT_TEST_FIXTURE.version}-future`,
      textSha256: 'b'.repeat(64),
    };
    const reaccepted = recordPromoterAgreementAcceptance(
      fetched!,
      futureArtifact,
      initial.userId,
      new Date(now.getTime() + 60_000),
      true,
    );
    await repository.save(reaccepted);

    const afterReacceptance = await repository.getById(initial.id);
    expect(afterReacceptance?.promoterAgreementAcceptances).toHaveLength(2);
    expect(afterReacceptance?.promoterAgreementAcceptances?.[1]).toMatchObject({
      version: futureArtifact.version,
      textSha256: futureArtifact.textSha256,
    });

    await db.collection('v2_onboarding_requests').doc(initial.id).delete();
    await db.terminate();
  }, 20_000);
});
