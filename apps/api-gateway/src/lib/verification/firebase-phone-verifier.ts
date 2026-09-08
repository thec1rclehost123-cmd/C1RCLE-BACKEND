import type {
  VerificationProvider,
  VerificationRequest,
  VerificationResult,
} from '@c1rcle/core/domain';
import type { Auth } from '@c1rcle/core/infrastructure';

/**
 * ─── Phone verification (GCP Identity Platform) ─────────────────────────────
 *
 * The client runs Firebase JS SDK's `signInWithPhoneNumber` (invisible
 * reCAPTCHA + the 6-digit code Identity Platform itself sends and verifies)
 * and hands us the resulting ID token as `VerificationRequest.proofToken`.
 * We verify that token server-side and confirm its `phone_number` claim
 * matches what the applicant entered — Identity Platform owns the entire
 * send/verify/rate-limit/cooldown lifecycle, so there is no local OTP
 * storage for phone (contrast `EmailOtpService`, which does own that
 * lifecycle because Identity Platform's email flow is a magic-link, not the
 * 6-digit-code UX the signup wizard needs).
 *
 * `documentType` must be exactly `'phone'` — any other type is not this
 * provider's concern (see `CompositeVerificationProvider`, which is what
 * routes `'phone'` here and everything else to the format-check default).
 */
export class FirebasePhoneVerificationProvider implements VerificationProvider {
  readonly name = 'firebase-phone';

  constructor(private readonly auth: Auth) {}

  async verify(request: VerificationRequest): Promise<VerificationResult> {
    if (!request.proofToken) {
      return { passed: false, provider: this.name, reason: 'missing_proof_token' };
    }

    let claimedPhone: string | undefined;
    let uid: string;
    try {
      const decoded = await this.auth.verifyIdToken(request.proofToken);
      claimedPhone = decoded.phone_number;
      uid = decoded.uid;
    } catch {
      return { passed: false, provider: this.name, reason: 'invalid_or_expired_token' };
    }

    if (!claimedPhone) {
      return { passed: false, provider: this.name, reason: 'token_has_no_phone_claim' };
    }
    if (normalizeToE164(claimedPhone) !== normalizeToE164(request.documentNumber)) {
      return { passed: false, provider: this.name, reason: 'phone_mismatch' };
    }
    return { passed: true, provider: this.name, reason: 'phone_verified', referenceId: uid };
  }
}

/**
 * v1's `toE164` rule, ported: a bare 10-digit number is assumed Indian
 * (`+91`-prefixed); anything else gets a bare `+` if it doesn't already
 * have one. Good enough to compare "the number the applicant typed" against
 * "the number Identity Platform's token actually verified" — both sides of
 * that comparison go through the same normalizer, so a formatting
 * difference (spaces, dashes) never produces a false mismatch.
 */
function normalizeToE164(phone: string): string {
  const digitsOnly = phone.replace(/[^\d+]/g, '');
  if (digitsOnly.startsWith('+')) return digitsOnly;
  if (/^\d{10}$/.test(digitsOnly)) return `+91${digitsOnly}`;
  return `+${digitsOnly}`;
}
