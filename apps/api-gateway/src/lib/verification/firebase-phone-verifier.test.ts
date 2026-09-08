import { describe, expect, it } from 'vitest';

import type { Auth } from '@c1rcle/core/infrastructure';

import { FirebasePhoneVerificationProvider } from './firebase-phone-verifier.js';

function fakeAuth(overrides: {
  verifyIdToken?: (token: string) => Promise<{ uid: string; phone_number?: string }>;
}): Auth {
  return {
    verifyIdToken:
      overrides.verifyIdToken ?? (async () => ({ uid: 'uid_1', phone_number: '+919876543210' })),
  } as unknown as Auth;
}

describe('FirebasePhoneVerificationProvider', () => {
  it('passes when the token phone_number claim matches the claimed number', async () => {
    const provider = new FirebasePhoneVerificationProvider(
      fakeAuth({ verifyIdToken: async () => ({ uid: 'uid_1', phone_number: '+919876543210' }) }),
    );
    const result = await provider.verify({
      documentType: 'phone',
      documentNumber: '9876543210',
      proofToken: 'token',
    });
    expect(result.passed).toBe(true);
    expect(result.referenceId).toBe('uid_1');
  });

  it('tolerates formatting differences (spaces, missing country code) via E.164 normalization', async () => {
    const provider = new FirebasePhoneVerificationProvider(
      fakeAuth({ verifyIdToken: async () => ({ uid: 'uid_1', phone_number: '+91 98765 43210' }) }),
    );
    const result = await provider.verify({
      documentType: 'phone',
      documentNumber: '098765 43210'.replace(/^0/, ''),
      proofToken: 'token',
    });
    expect(result.passed).toBe(true);
  });

  it('fails when the claimed number does not match the token', async () => {
    const provider = new FirebasePhoneVerificationProvider(
      fakeAuth({ verifyIdToken: async () => ({ uid: 'uid_1', phone_number: '+919876543210' }) }),
    );
    const result = await provider.verify({
      documentType: 'phone',
      documentNumber: '+911111111111',
      proofToken: 'token',
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('phone_mismatch');
  });

  it('fails with no proofToken', async () => {
    const provider = new FirebasePhoneVerificationProvider(fakeAuth({}));
    const result = await provider.verify({
      documentType: 'phone',
      documentNumber: '+919876543210',
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('missing_proof_token');
  });

  it('fails when the token is invalid or expired', async () => {
    const provider = new FirebasePhoneVerificationProvider(
      fakeAuth({
        verifyIdToken: async () => {
          throw new Error('invalid token');
        },
      }),
    );
    const result = await provider.verify({
      documentType: 'phone',
      documentNumber: '+919876543210',
      proofToken: 'bad-token',
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('invalid_or_expired_token');
  });

  it('fails when the token has no phone_number claim', async () => {
    const provider = new FirebasePhoneVerificationProvider(
      fakeAuth({ verifyIdToken: async () => ({ uid: 'uid_1' }) }),
    );
    const result = await provider.verify({
      documentType: 'phone',
      documentNumber: '+919876543210',
      proofToken: 'token',
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('token_has_no_phone_claim');
  });
});
