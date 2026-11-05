import { describe, expect, it } from 'vitest';

import { saveOnboardingProgressSchema } from './contracts/onboarding.js';

describe('private applicant KYC contract', () => {
  it('accepts existing fields and rejects authority flags or malformed identity details', () => {
    const identity = { idType: 'passport', idNumber: 'P1234567' };
    expect(saveOnboardingProgressSchema.safeParse({ kyc: { identity } }).success).toBe(true);
    expect(
      saveOnboardingProgressSchema.safeParse({ kyc: { identity: { ...identity, verified: true } } })
        .success,
    ).toBe(false);
    expect(
      saveOnboardingProgressSchema.safeParse({
        kyc: { identity: { ...identity, idNumber: 'bad' } },
      }).success,
    ).toBe(false);
    expect(saveOnboardingProgressSchema.safeParse({ kyc: { role: 'admin' } }).success).toBe(false);
    expect(
      saveOnboardingProgressSchema.safeParse({ kyc: { business: { pan: 'bad', address: 'x' } } })
        .success,
    ).toBe(false);
  });
});
