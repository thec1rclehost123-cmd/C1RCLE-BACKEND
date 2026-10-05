/**
 * ─── KYC document verification (Phase 2) ─────────────────────────────────────
 *
 * v1 shipped an "Aadhaar check" that was a Verhoeff-checksum test on the
 * number itself. A checksum proves the digits are well-formed; it proves
 * nothing about whether the person exists or the document is theirs. Porting
 * it as-is would put a verification-shaped hole in the approval path, so the
 * roadmap calls for a **pluggable provider** instead
 * (`docs/roadmap/phase-02-kyc-onboarding.md`).
 *
 * This port is that seam. The domain states what a verification *answers*; a
 * real Aadhaar/DigiLocker integration, a manual-review queue, or the local
 * format-check stub all satisfy it without the approval path changing.
 */

export interface VerificationRequest {
  /** Document kind: `aadhaar`, `pan`, `gstin`, `phone`, … */
  documentType: string;
  /** The identifier being checked. Never logged in full. */
  documentNumber: string;
  /** Name as printed on the document, when the provider can match on it. */
  holderName?: string;
  /**
   * A provider-issued proof to check rather than a value to format-validate
   * — e.g. `documentType: 'phone'`'s GCP Identity Platform ID token from the
   * client's `signInWithPhoneNumber` flow. Ignored by providers that only
   * do a structural check (`FormatCheckVerificationProvider`).
   */
  proofToken?: string;
}

export interface VerificationResult {
  /**
   * `false` does not mean "fraud" — it means this provider could not confirm
   * the document. Only `passed` is ever treated as evidence.
   */
  passed: boolean;
  /** Provider name recorded on the attempt, so a swap is visible in history. */
  provider: string;
  /** Machine-readable reason when `passed` is false, e.g. `malformed`. */
  reason?: string;
  /** Provider's own reference id, for support to quote back. */
  referenceId?: string;
}

export interface VerificationProvider {
  readonly name: string;
  verify(request: VerificationRequest): Promise<VerificationResult>;
}

/**
 * The default provider: a **format check only**, and it says so.
 *
 * It is deliberately not called `AadhaarVerificationProvider` and its results
 * are deliberately named `format_ok` rather than `verified`, because the one
 * failure mode that matters here is an operator reading a green tick as
 * "identity confirmed". Approval policy therefore treats a pass from this
 * provider as "nothing obviously wrong", not as verification — see
 * `OnboardingService.approve`, which requires a human admin decision
 * regardless of what any provider returned.
 */
/**
 * Verhoeff algorithm implementation for Aadhaar checksum validation.
 * Aadhaar is a 12-digit number where the last digit is a checksum.
 */

// Better to use exact from v1
const VERHOEFF_D_TABLE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const VERHOEFF_P_TABLE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function validateAadhaarVerhoeff(aadhaar: string): boolean {
  if (!/^\d{12}$/.test(aadhaar)) {
    return false;
  }
  if (aadhaar.startsWith('0') || aadhaar.startsWith('1')) {
    return false;
  }
  let c = 0;
  const invertedArray = aadhaar.split('').map(Number).reverse();
  for (let i = 0; i < invertedArray.length; i++) {
    const digit = invertedArray[i] ?? 0;
    const pRow = VERHOEFF_P_TABLE[i % 8];
    const pVal = pRow?.[digit] ?? 0;
    const dRow = VERHOEFF_D_TABLE[c];
    c = dRow?.[pVal] ?? 0;
  }
  return c === 0;
}

export class FormatCheckVerificationProvider implements VerificationProvider {
  readonly name = 'format-check';

  async verify(request: VerificationRequest): Promise<VerificationResult> {
    const digits = request.documentNumber.replace(/\s/g, '').toUpperCase();
    const docType = request.documentType;

    if (docType === 'aadhaar') {
      if (validateAadhaarVerhoeff(digits)) {
        return { passed: true, provider: this.name, reason: 'format_ok' };
      }
      return { passed: false, provider: this.name, reason: 'malformed' };
    }

    const pattern = FORMATS[docType];
    if (!pattern) {
      return { passed: false, provider: this.name, reason: 'unsupported_document_type' };
    }
    return pattern.test(digits)
      ? { passed: true, provider: this.name, reason: 'format_ok' }
      : { passed: false, provider: this.name, reason: 'malformed' };
  }
}

const FORMATS: Record<string, RegExp> = {
  aadhaar: /^[2-9][0-9]{11}$/,
  pan: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
  gstin: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/,
};

/**
 * Dispatches by `documentType` to one of several single-purpose providers,
 * so `OnboardingService`'s `ServiceDeps.verification` slot can stay a single
 * `VerificationProvider` (one call site, one rate-limit/audit path — see
 * `verifyDocument`) even though phone verification (GCP Identity Platform,
 * an ID-token check) and document verification (structural format check)
 * are answered by entirely different mechanisms.
 */
export class CompositeVerificationProvider implements VerificationProvider {
  readonly name = 'composite';

  constructor(
    private readonly byDocumentType: Record<string, VerificationProvider>,
    private readonly fallback: VerificationProvider,
  ) {}

  async verify(request: VerificationRequest): Promise<VerificationResult> {
    const provider = this.byDocumentType[request.documentType] ?? this.fallback;
    return provider.verify(request);
  }
}
