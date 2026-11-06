import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createOnboardingRequest } from '../domain/models/onboarding.js';
import {
  hasCurrentPromoterAgreementAcceptance,
  recordPromoterAgreementAcceptance,
  PROMOTER_AGREEMENT_TEST_FIXTURE,
} from '../domain/models/promoter-agreement.js';

import { createCoreConfig, currentPromoterAgreement } from './index.js';

const text =
  'C1RCLE STAGING PROMOTER AGREEMENT — FOR TESTING ONLY\nNon-legal staging acceptance fixture; confers no production rights.';
const artifact = {
  version: `staging-promoter-v1-${createHash('sha256').update(text).digest('hex')}`,
  status: 'staging_only' as const,
  text,
  textSha256: createHash('sha256').update(text).digest('hex'),
};
const base = {
  redis: { url: 'redis://localhost:6379' },
  firestore: { projectId: 'demo-agreement' },
};
const request = () =>
  createOnboardingRequest({
    id: 'synthetic-application',
    userId: 'synthetic-user',
    requestedType: 'promoter',
    plan: 'basic',
    profile: {
      legalName: 'Synthetic Promoter',
      contactPerson: 'Synthetic',
      phone: '+919000000001',
      city: 'Test City',
    },
  });

describe('hosted Promoter agreement policy', () => {
  it('fails closed without an artifact in production and staging', () => {
    for (const deploymentEnvironment of ['production', 'staging'] as const)
      expect(
        currentPromoterAgreement(createCoreConfig({ ...base, deploymentEnvironment })),
      ).toBeNull();
  });
  it('accepts staging-only artifacts only with explicit staging configuration', () => {
    expect(
      currentPromoterAgreement(
        createCoreConfig({
          ...base,
          deploymentEnvironment: 'staging',
          promoterAgreement: artifact,
        }),
      ),
    ).toEqual(artifact);
    for (const deploymentEnvironment of ['production', 'local'] as const)
      expect(() =>
        createCoreConfig({ ...base, deploymentEnvironment, promoterAgreement: artifact }),
      ).toThrow();
    expect(() => createCoreConfig({ ...base, promoterAgreement: artifact })).toThrow();
  });
  it('rejects bad hashes, unlabeled staging versions, and configured test fixtures', () => {
    for (const promoterAgreement of [
      { ...artifact, textSha256: '0'.repeat(64) },
      { ...artifact, version: 'v1' },
      PROMOTER_AGREEMENT_TEST_FIXTURE,
    ])
      expect(() =>
        createCoreConfig({ ...base, deploymentEnvironment: 'staging', promoterAgreement }),
      ).toThrow();
  });
  it('binds acceptance to actor, version, status, and exact content while preserving history', () => {
    const now = new Date('2026-11-06T19:00:00Z');
    const accepted = recordPromoterAgreementAcceptance(
      request(),
      artifact,
      'synthetic-user',
      now,
      false,
    );
    expect(hasCurrentPromoterAgreementAcceptance(accepted, artifact, false)).toBe(true);
    expect(
      recordPromoterAgreementAcceptance(accepted, artifact, 'synthetic-user', now, false),
    ).toBe(accepted);
    expect(
      hasCurrentPromoterAgreementAcceptance({ ...accepted, userId: 'other' }, artifact, false),
    ).toBe(false);
    expect(
      hasCurrentPromoterAgreementAcceptance(accepted, { ...artifact, status: 'approved' }, false),
    ).toBe(false);
    expect(
      hasCurrentPromoterAgreementAcceptance(
        accepted,
        { ...artifact, version: 'staging-v2' },
        false,
      ),
    ).toBe(false);
    expect(() =>
      recordPromoterAgreementAcceptance(
        accepted,
        { ...artifact, textSha256: '0'.repeat(64) },
        'synthetic-user',
        now,
        false,
      ),
    ).toThrow();
    const renewed = recordPromoterAgreementAcceptance(
      accepted,
      { ...artifact, version: 'staging-v2' },
      'synthetic-user',
      now,
      false,
    );
    expect(renewed.promoterAgreementAcceptances).toHaveLength(2);
    expect(accepted.promoterAgreementAcceptances).toHaveLength(1);
  });
  it('supports a separately approved production artifact without accepting staging evidence', () => {
    const text = 'Synthetic unit-test document for approved-artifact wiring; no legal terms.';
    const production = {
      version: `unit-production-v1-${createHash('sha256').update(text).digest('hex')}`,
      status: 'approved' as const,
      text,
      textSha256: createHash('sha256').update(text).digest('hex'),
    };
    const config = createCoreConfig({ ...base, promoterAgreement: production });
    expect(currentPromoterAgreement(config)).toEqual(production);
    const staged = recordPromoterAgreementAcceptance(
      request(),
      artifact,
      'synthetic-user',
      new Date(),
      false,
    );
    expect(hasCurrentPromoterAgreementAcceptance(staged, production, false)).toBe(false);
    const accepted = recordPromoterAgreementAcceptance(
      staged,
      production,
      'synthetic-user',
      new Date(),
      false,
    );
    expect(hasCurrentPromoterAgreementAcceptance(accepted, production, false)).toBe(true);
  });
  it('never falls back to the test fixture under explicit production policy', () => {
    expect(
      currentPromoterAgreement(
        createCoreConfig({
          ...base,
          deploymentEnvironment: 'production',
          features: { m4PromoterAgreementFixture: true },
        }),
      ),
    ).toBeNull();
    expect(
      currentPromoterAgreement(
        createCoreConfig({
          ...base,
          deploymentEnvironment: 'local',
          features: { m4PromoterAgreementFixture: true },
        }),
      ),
    ).toEqual(PROMOTER_AGREEMENT_TEST_FIXTURE);
  });
  it('continues rejecting test-fixture acceptance outside emulator policy', () => {
    expect(() =>
      recordPromoterAgreementAcceptance(
        request(),
        PROMOTER_AGREEMENT_TEST_FIXTURE,
        'synthetic-user',
        new Date(),
        false,
      ),
    ).toThrow();
    expect(
      hasCurrentPromoterAgreementAcceptance(request(), PROMOTER_AGREEMENT_TEST_FIXTURE, false),
    ).toBe(false);
  });
});
