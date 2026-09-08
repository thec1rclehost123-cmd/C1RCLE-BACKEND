import { describe, expect, it } from 'vitest';

import {
  EMAIL_OTP_COOLDOWN_SECONDS,
  EMAIL_OTP_EXPIRY_MINUTES,
  MAX_EMAIL_OTP_ATTEMPTS,
  assertCanResend,
  createEmailOtp,
  generateEmailOtpCode,
  hashEmailOtpCode,
  isEmailOtpExpired,
  isEmailOtpLocked,
  normalizeEmailRecipient,
  recordFailedEmailOtpAttempt,
  verifyEmailOtpCode,
} from './models/email-otp.js';

describe('generateEmailOtpCode', () => {
  it('is always a 6-digit zero-padded numeric string', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateEmailOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});

describe('normalizeEmailRecipient', () => {
  it('lower-cases and trims', () => {
    expect(normalizeEmailRecipient(' Foo@Example.com ')).toBe('foo@example.com');
  });
});

describe('createEmailOtp', () => {
  it('hashes the code, never stores it plaintext', () => {
    const now = new Date('2026-09-08T00:00:00.000Z');
    const otp = createEmailOtp('foo@example.com', '123456', now);
    expect(otp.codeHash).toBe(hashEmailOtpCode('123456'));
    expect(JSON.stringify(otp)).not.toContain('123456');
  });

  it('sets a 10-minute expiry and zero attempts', () => {
    const now = new Date('2026-09-08T00:00:00.000Z');
    const otp = createEmailOtp('foo@example.com', '123456', now);
    expect(Date.parse(otp.expiresAt) - now.getTime()).toBe(EMAIL_OTP_EXPIRY_MINUTES * 60_000);
    expect(otp.attempts).toBe(0);
  });
});

describe('assertCanResend', () => {
  it('allows the first send (no existing record)', () => {
    expect(() => assertCanResend(null, new Date())).not.toThrow();
  });

  it('rejects a resend inside the 60s cooldown', () => {
    const sentAt = new Date('2026-09-08T00:00:00.000Z');
    const otp = createEmailOtp('foo@example.com', '123456', sentAt);
    const tooSoon = new Date(sentAt.getTime() + 30_000);
    expect(() => assertCanResend(otp, tooSoon)).toThrow(/wait/);
  });

  it('allows a resend once the cooldown elapses', () => {
    const sentAt = new Date('2026-09-08T00:00:00.000Z');
    const otp = createEmailOtp('foo@example.com', '123456', sentAt);
    const later = new Date(sentAt.getTime() + EMAIL_OTP_COOLDOWN_SECONDS * 1000 + 1);
    expect(() => assertCanResend(otp, later)).not.toThrow();
  });
});

describe('verifyEmailOtpCode', () => {
  const sentAt = new Date('2026-09-08T00:00:00.000Z');

  it('accepts the correct code', () => {
    const otp = createEmailOtp('foo@example.com', '123456', sentAt);
    expect(() => verifyEmailOtpCode(otp, '123456', sentAt)).not.toThrow();
  });

  it('rejects the wrong code', () => {
    const otp = createEmailOtp('foo@example.com', '123456', sentAt);
    expect(() => verifyEmailOtpCode(otp, '000000', sentAt)).toThrow(/Invalid authorization code/);
  });

  it('rejects an expired code', () => {
    const otp = createEmailOtp('foo@example.com', '123456', sentAt);
    const later = new Date(sentAt.getTime() + (EMAIL_OTP_EXPIRY_MINUTES * 60_000 + 1));
    expect(() => verifyEmailOtpCode(otp, '123456', later)).toThrow(/expired/);
  });

  it('rejects after MAX_EMAIL_OTP_ATTEMPTS failed attempts, even with the right code', () => {
    let otp = createEmailOtp('foo@example.com', '123456', sentAt);
    for (let i = 0; i < MAX_EMAIL_OTP_ATTEMPTS; i++) {
      otp = recordFailedEmailOtpAttempt(otp);
    }
    expect(isEmailOtpLocked(otp)).toBe(true);
    expect(() => verifyEmailOtpCode(otp, '123456', sentAt)).toThrow(/Too many attempts/);
  });
});

describe('isEmailOtpExpired', () => {
  it('is false right at creation, true after the expiry window', () => {
    const now = new Date('2026-09-08T00:00:00.000Z');
    const otp = createEmailOtp('foo@example.com', '123456', now);
    expect(isEmailOtpExpired(otp, now)).toBe(false);
    const after = new Date(now.getTime() + EMAIL_OTP_EXPIRY_MINUTES * 60_000 + 1);
    expect(isEmailOtpExpired(otp, after)).toBe(true);
  });
});
