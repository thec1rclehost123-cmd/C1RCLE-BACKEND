import type { Logger } from '../../telemetry/logger.js';

/**
 * ─── EmailSender Port ───────────────────────────────────────────────────────
 * Pluggable interface for outbound transactional email (currently: OTP codes
 * only). Mirrors `payment-provider.ts`'s provider-abstraction pattern — the
 * interface lives here with a safe default; a real implementation (Resend,
 * a GCP-relayed SMTP sender, …) lives in `apps/api-gateway/src/lib/` since it
 * needs `process.env`/network access that `packages/core` may not touch.
 */

export interface OnboardingChangesRequestedEmailParams {
  legalName: string;
  note: string;
}

export interface EmailSender {
  readonly name: string;
  sendOtpEmail(recipient: string, code: string): Promise<void>;
  /** Sends the password-reset link (Better Auth `sendResetPassword` callback). */
  sendPasswordResetEmail(recipient: string, resetUrl: string): Promise<void>;
  /** Notifies an applicant that their onboarding application needs changes. */
  sendOnboardingChangesRequestedEmail(
    recipient: string,
    params: OnboardingChangesRequestedEmailParams,
  ): Promise<void>;
}

/**
 * Dev/test default: logs the code instead of sending. Never used in
 * production — the real sender must be wired via `StorageDriverConfig`-style
 * fail-closed config, same as every other external-provider default in this
 * codebase (see `payment-provider.ts`'s `MemoryPaymentProvider` doc comment).
 */
export class LoggingEmailSender implements EmailSender {
  readonly name = 'logging';

  constructor(private readonly logger: Logger) {}

  async sendOtpEmail(recipient: string, code: string): Promise<void> {
    this.logger.info('dev_email_otp', { recipient, code });
  }

  async sendPasswordResetEmail(recipient: string, resetUrl: string): Promise<void> {
    this.logger.info('dev_email_password_reset', { recipient, resetUrl });
  }

  async sendOnboardingChangesRequestedEmail(
    recipient: string,
    params: OnboardingChangesRequestedEmailParams,
  ): Promise<void> {
    // Note text is admin-authored review feedback, not logged in full here —
    // same "log length, not content" convention the rest of this codebase
    // follows for request-body logging.
    this.logger.info('dev_email_onboarding_changes_requested', {
      recipient,
      legalName: params.legalName,
      noteLength: params.note.length,
    });
  }
}
