import { createHash, randomInt } from 'node:crypto';

import { InvalidOperationError } from '../errors.js';

/**
 * ─── Email OTP (auth signup/verification) ───────────────────────────────────
 *
 * Ported from v1's proven `guest-otp.ts` rules: 6-digit numeric code, hashed
 * at rest (SHA-256, never plaintext), 10-minute expiry, 60-second resend
 * cooldown per recipient, 5-attempt lockout. One improvement over v1: the
 * code is generated with `crypto.randomInt` (CSPRNG) rather than
 * `Math.random()` — v1's generator was not cryptographically secure.
 *
 * One doc per recipient, fully replaced on each send (no optimistic-lock
 * version — matches v1's `docRef.set` semantics; the cooldown check is what
 * prevents a resend race, not a version field).
 */

export const EMAIL_OTP_EXPIRY_MINUTES = 10;
export const EMAIL_OTP_COOLDOWN_SECONDS = 60;
export const MAX_EMAIL_OTP_ATTEMPTS = 5;

export interface EmailOtp {
  /** Normalized (lower-cased, trimmed) recipient email — the doc key. */
  recipient: string;
  codeHash: string;
  expiresAt: string;
  lastSentAt: string;
  attempts: number;
}

export function normalizeEmailRecipient(email: string): string {
  return email.trim().toLowerCase();
}

/** 6-digit numeric code, CSPRNG. */
export function generateEmailOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashEmailOtpCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function createEmailOtp(recipient: string, code: string, now: Date): EmailOtp {
  return {
    recipient: normalizeEmailRecipient(recipient),
    codeHash: hashEmailOtpCode(code),
    expiresAt: new Date(now.getTime() + EMAIL_OTP_EXPIRY_MINUTES * 60_000).toISOString(),
    lastSentAt: now.toISOString(),
    attempts: 0,
  };
}

/** Throws if a resend is requested before the cooldown elapses. */
export function assertCanResend(existing: EmailOtp | null, now: Date): void {
  if (!existing) return;
  const elapsedSeconds = (now.getTime() - Date.parse(existing.lastSentAt)) / 1000;
  if (elapsedSeconds < EMAIL_OTP_COOLDOWN_SECONDS) {
    const waitSeconds = Math.ceil(EMAIL_OTP_COOLDOWN_SECONDS - elapsedSeconds);
    throw new InvalidOperationError(`Please wait ${waitSeconds}s before requesting another code.`);
  }
}

export function isEmailOtpExpired(otp: EmailOtp, now: Date): boolean {
  return now.getTime() > Date.parse(otp.expiresAt);
}

export function isEmailOtpLocked(otp: EmailOtp): boolean {
  return otp.attempts >= MAX_EMAIL_OTP_ATTEMPTS;
}

export function recordFailedEmailOtpAttempt(otp: EmailOtp): EmailOtp {
  return { ...otp, attempts: otp.attempts + 1 };
}

/**
 * Verifies `code` against `otp`. Throws a specific `InvalidOperationError`
 * for each failure reason (no ritual/expired/locked/mismatch) — callers map
 * these to a flat 400, never leaking which specific reason to an attacker
 * beyond what v1 already exposed (v1's own messages were this specific).
 */
export function verifyEmailOtpCode(otp: EmailOtp, code: string, now: Date): void {
  if (isEmailOtpExpired(otp, now)) {
    throw new InvalidOperationError('Authorization code expired.');
  }
  if (isEmailOtpLocked(otp)) {
    throw new InvalidOperationError('Too many attempts. Request a new code.');
  }
  if (hashEmailOtpCode(code) !== otp.codeHash) {
    throw new InvalidOperationError('Invalid authorization code.');
  }
}
