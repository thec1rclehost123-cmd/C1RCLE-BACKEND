import { InvalidOperationError } from '../../domain/errors.js';
import {
  assertCanResend,
  createEmailOtp,
  generateEmailOtpCode,
  normalizeEmailRecipient,
  recordFailedEmailOtpAttempt,
  verifyEmailOtpCode,
} from '../../domain/models/email-otp.js';

import type { EmailSender } from '../../domain/ports/email-sender.js';
import type { EmailOtpRepository } from '../../domain/ports/repositories.js';
import type { ServiceDeps } from '../context.js';

/**
 * ─── Email OTP Service ───────────────────────────────────────────────────────
 *
 * Pre-session — there is no `ActorContext` yet at signup time, so unlike
 * every other Phase's services there is no `requireOrgAccess` gate here.
 * Abuse resistance is layered: the route applies the `OTP_SEND`/`OTP_VERIFY`
 * rate-limit classes (5/min, 10/min per v1's proven thresholds), and the
 * domain model enforces the 60s resend cooldown + 5-attempt lockout
 * independent of the HTTP-level limiter, matching v1's own defense-in-depth.
 */

export interface EmailOtpServiceDeps {
  emailOtp: EmailOtpRepository;
  emailSender: EmailSender;
  config: ServiceDeps['config'];
}

export interface EmailOtpService {
  send(recipient: string): Promise<void>;
  verify(recipient: string, code: string): Promise<void>;
}

export function createEmailOtpService(deps: EmailOtpServiceDeps): EmailOtpService {
  const { emailOtp, emailSender, config } = deps;

  async function send(recipient: string): Promise<void> {
    const now = config.clock.now();
    const normalized = normalizeEmailRecipient(recipient);
    const existing = await emailOtp.get(normalized);
    assertCanResend(existing, now);

    const code = generateEmailOtpCode();
    const otp = createEmailOtp(normalized, code, config.emailOtpSecret, now);
    await emailOtp.save(otp);
    await emailSender.sendOtpEmail(normalized, code);
  }

  async function verify(recipient: string, code: string): Promise<void> {
    const now = config.clock.now();
    const normalized = normalizeEmailRecipient(recipient);
    const otp = await emailOtp.get(normalized);
    if (!otp) {
      throw new InvalidOperationError('No verification in progress for this address.');
    }

    try {
      verifyEmailOtpCode(otp, code, config.emailOtpSecret, now);
    } catch (error) {
      // A wrong code (not expiry/lockout, which need no attempt bump) still
      // counts against the lockout — persist the incremented attempt before
      // re-throwing, mirroring v1's `docRef.update` on mismatch.
      if (
        error instanceof InvalidOperationError &&
        error.message === 'Invalid authorization code.'
      ) {
        await emailOtp.save(recordFailedEmailOtpAttempt(otp));
      }
      throw error;
    }

    // Single-use: delete on success so a replayed code can never verify twice.
    await emailOtp.delete(normalized);
  }

  return { send, verify };
}
