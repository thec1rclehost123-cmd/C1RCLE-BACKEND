import { describe, expect, it } from 'vitest';

import { createOnboardingRequest } from './models/onboarding.js';
import {
  hasCurrentPromoterAgreementAcceptance,
  PROMOTER_AGREEMENT_TEST_FIXTURE,
  recordPromoterAgreementAcceptance,
} from './models/promoter-agreement.js';

const NOW = new Date('2026-10-28T12:00:00.000Z');

function request(requestedType: 'host' | 'promoter' = 'promoter') {
  return createOnboardingRequest({
    id: 'onboarding_1',
    userId: 'user_1',
    requestedType,
    plan: 'basic',
    profile: { legalName: 'Promoter', contactPerson: 'Owner', phone: '9876543210', city: 'Pune' },
    now: NOW,
  });
}

describe('Promoter agreement evidence', () => {
  it('stores a version, content hash, accepting actor, and timestamp and is idempotent', () => {
    const first = recordPromoterAgreementAcceptance(
      request(),
      PROMOTER_AGREEMENT_TEST_FIXTURE,
      'user_1',
      NOW,
      true,
    );

    expect(first.promoterAgreementAcceptances).toEqual([
      {
        version: PROMOTER_AGREEMENT_TEST_FIXTURE.version,
        artifactStatus: 'test_fixture',
        textSha256: PROMOTER_AGREEMENT_TEST_FIXTURE.textSha256,
        acceptedBy: 'user_1',
        acceptedAt: NOW.toISOString(),
      },
    ]);
    expect(
      recordPromoterAgreementAcceptance(
        first,
        PROMOTER_AGREEMENT_TEST_FIXTURE,
        'user_1',
        NOW,
        true,
      ),
    ).toBe(first);
    expect(
      hasCurrentPromoterAgreementAcceptance(first, PROMOTER_AGREEMENT_TEST_FIXTURE, true),
    ).toBe(true);
    expect(
      hasCurrentPromoterAgreementAcceptance(first, PROMOTER_AGREEMENT_TEST_FIXTURE, false),
    ).toBe(false);
  });

  it('preserves prior versions for audit and requires reacceptance of a future version', () => {
    const acceptedV1 = recordPromoterAgreementAcceptance(
      request(),
      PROMOTER_AGREEMENT_TEST_FIXTURE,
      'user_1',
      NOW,
      true,
    );
    const future = {
      ...PROMOTER_AGREEMENT_TEST_FIXTURE,
      version: 'm4-test-fixture-v2',
      text: `${PROMOTER_AGREEMENT_TEST_FIXTURE.text} Updated fixture version.`,
      textSha256: 'b'.repeat(64),
    };

    expect(hasCurrentPromoterAgreementAcceptance(acceptedV1, future, true)).toBe(false);
    const acceptedV2 = recordPromoterAgreementAcceptance(acceptedV1, future, 'user_1', NOW, true);
    expect(acceptedV2.promoterAgreementAcceptances).toHaveLength(2);
    expect(hasCurrentPromoterAgreementAcceptance(acceptedV2, future, true)).toBe(true);
  });

  it('refuses fixture acceptance outside test mode and refuses non-Promoter applicants', () => {
    expect(() =>
      recordPromoterAgreementAcceptance(
        request(),
        PROMOTER_AGREEMENT_TEST_FIXTURE,
        'user_1',
        NOW,
        false,
      ),
    ).toThrow(/emulator\/test mode/);
    expect(() =>
      recordPromoterAgreementAcceptance(
        request('host'),
        PROMOTER_AGREEMENT_TEST_FIXTURE,
        'user_1',
        NOW,
        true,
      ),
    ).toThrow(/Promoter applicants/);
  });

  it('rejects content changes that reuse an accepted version', () => {
    const accepted = recordPromoterAgreementAcceptance(
      request(),
      PROMOTER_AGREEMENT_TEST_FIXTURE,
      'user_1',
      NOW,
      true,
    );
    expect(() =>
      recordPromoterAgreementAcceptance(
        accepted,
        { ...PROMOTER_AGREEMENT_TEST_FIXTURE, textSha256: 'c'.repeat(64) },
        'user_1',
        NOW,
        true,
      ),
    ).toThrow(/without a version change/);
  });
});
