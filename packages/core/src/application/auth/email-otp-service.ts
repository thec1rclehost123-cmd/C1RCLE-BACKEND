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
import type { EmailOtpRepository, UserAccountRepository } from '../../domain/ports/repositories.js';
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
  users: UserAccountRepository;
  emailSender: EmailSender;
  config: ServiceDeps['config'];
}

export interface EmailOtpService {
  send(recipient: string): Promise<void>;
  verify(recipient: string, code: string): Promise<void>;
}

export function createEmailOtpService(deps: EmailOtpServiceDeps): EmailOtpService {
  const { emailOtp, users, emailSender, config } = deps;

  async function send(recipient: string): Promise<void> {
    const normalized = normalizeEmailRecipient(recipient);
    const account = await users.getByEmail(normalized);
    if (!account) throw new InvalidOperationError('No account available for verification.');
    const code = generateEmailOtpCode();
    await emailOtp.updateAtomically(normalized, (existing) => {
      const now = config.clock.now();
      assertCanResend(existing, now);
      return {
        next: createEmailOtp(normalized, code, config.emailOtpSecret, now, account.id),
        result: undefined,
      };
    });
    // Provider calls must never run inside a retryable transaction.
    await emailSender.sendOtpEmail(normalized, code);
  }

  async function verify(recipient: string, code: string): Promise<void> {
    const normalized = normalizeEmailRecipient(recipient);
    const failure = await emailOtp.updateAtomically<InvalidOperationError | null>(
      normalized,
      (otp) => {
        if (!otp) {
          throw new InvalidOperationError('No verification in progress for this address.');
        }
        const now = config.clock.now();
        try {
          // Re-evaluate time on every transaction retry, not just request arrival.
          verifyEmailOtpCode(otp, code, config.emailOtpSecret, now);
        } catch (error) {
          if (!(error instanceof InvalidOperationError)) throw error;
          return {
            next:
              error.message === 'Invalid authorization code.'
                ? recordFailedEmailOtpAttempt(otp)
                : otp,
            result: error,
          };
        }
        return { next: null, result: null, verifyAccountAt: now.toISOString() };
      },
    );
    // Throw only after the failed-attempt increment has committed.
    if (failure) throw failure;
  }

  return { send, verify };
}
