import { createHash } from 'node:crypto';

import { InvalidOperationError } from '../errors.js';
import { bumpVersion } from '../identity.js';

import type { EntityId } from '../identity.js';
import type { OnboardingRequest } from './onboarding.js';

export type PromoterAgreementStatus = 'test_fixture' | 'approved';

export interface PromoterAgreementArtifact {
  version: string;
  status: PromoterAgreementStatus;
  text: string;
  textSha256: string;
}

export interface PromoterAgreementAcceptance {
  version: string;
  artifactStatus: PromoterAgreementStatus;
  textSha256: string;
  acceptedBy: EntityId;
  acceptedAt: string;
}

/**
 * Explicitly non-legal fixture text. Gateway configuration exposes it only
 * when the memory adapter or both Firebase Auth and Firestore emulators are in
 * use. There is intentionally no approved agreement artifact in M4 yet.
 */
const PROMOTER_AGREEMENT_TEST_TEXT =
  'TEST FIXTURE ONLY — NOT A LEGAL AGREEMENT. This text exists only to test M4 agreement storage and must never be used as real Promoter terms.';

export const PROMOTER_AGREEMENT_TEST_FIXTURE: PromoterAgreementArtifact = Object.freeze({
  version: 'm4-test-fixture-2026-10-28-v1',
  status: 'test_fixture',
  text: PROMOTER_AGREEMENT_TEST_TEXT,
  textSha256: createHash('sha256').update(PROMOTER_AGREEMENT_TEST_TEXT).digest('hex'),
});

export function recordPromoterAgreementAcceptance(
  request: OnboardingRequest,
  artifact: PromoterAgreementArtifact,
  actorId: EntityId,
  now: Date,
  allowTestFixture: boolean,
): OnboardingRequest {
  if (request.requestedType !== 'promoter') {
    throw new InvalidOperationError(
      'Promoter agreement can only be accepted by Promoter applicants',
    );
  }
  if (artifact.status === 'test_fixture' && !allowTestFixture) {
    throw new InvalidOperationError(
      'Test fixture agreement is available only in emulator/test mode',
    );
  }
  const existing = request.promoterAgreementAcceptances?.find(
    (acceptance) => acceptance.version === artifact.version,
  );
  if (existing) {
    if (
      existing.textSha256 !== artifact.textSha256 ||
      existing.artifactStatus !== artifact.status
    ) {
      throw new InvalidOperationError('Agreement content changed without a version change');
    }
    return request;
  }

  const acceptance: PromoterAgreementAcceptance = {
    version: artifact.version,
    artifactStatus: artifact.status,
    textSha256: artifact.textSha256,
    acceptedBy: actorId,
    acceptedAt: now.toISOString(),
  };
  return bumpVersion(
    {
      ...request,
      promoterAgreementAcceptances: [...(request.promoterAgreementAcceptances ?? []), acceptance],
    },
    now,
  );
}

export function hasCurrentPromoterAgreementAcceptance(
  request: OnboardingRequest | null,
  artifact: PromoterAgreementArtifact | null,
  allowTestFixture: boolean,
): boolean {
  if (!request || !artifact || request.requestedType !== 'promoter') return false;
  if (artifact.status === 'test_fixture' && !allowTestFixture) return false;
  return (request.promoterAgreementAcceptances ?? []).some(
    (acceptance) =>
      acceptance.version === artifact.version &&
      acceptance.textSha256 === artifact.textSha256 &&
      acceptance.artifactStatus === artifact.status,
  );
}
