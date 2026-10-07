import type { Logger } from '../../telemetry/logger.js';

/**
 * ─── EmailSender Port ───────────────────────────────────────────────────────
 * Pluggable interface for outbound transactional email (OTP codes + staff
 * invitations). Mirrors `payment-provider.ts`'s provider-abstraction pattern
 * — the interface lives here with a safe default; a real implementation
 * (Resend, a GCP-relayed SMTP sender, …) lives in `apps/api-gateway/src/lib/`
 * since it needs `process.env`/network access that `packages/core` may not
 * touch.
 */

export interface StaffInvitationEmail {
  /** Normalized recipient address. */
  to: string;
  /** Inviting organization display name. */
  orgName: string;
  /** Role the invitee gets on accept (`admin`|`manager`|`member`). */
  role: string;
  /** Capabilities the invite grants (may be empty). */
  capabilities: readonly string[];
  /** Invitation expiry (ISO datetime) for the "expires on" line. */
  expiresAt: string;
  /** Absolute accept URL. Absent when no dashboard URL is configured — the
   * template then tells the invitee to ask their manager for the link. */
  acceptUrl?: string | undefined;
  /**
   * Temporary sign-in password, set only when a brand-new account was
   * provisioned for the invitee. Existing accounts keep their own password
   * and receive no credentials — the template omits the credentials box.
   */
  temporaryPassword?: string | undefined;
}

export interface OnboardingChangesRequestedEmailParams {
  legalName: string;
  note: string;
}

export interface EmailSender {
  readonly name: string;
  sendOtpEmail(recipient: string, code: string): Promise<void>;
  sendStaffInvitationEmail(invitation: StaffInvitationEmail): Promise<void>;
  /** Sends the password-reset link (Better Auth `sendResetPassword` callback). */
  sendPasswordResetEmail(recipient: string, resetUrl: string): Promise<void>;
  /** Notifies an applicant that their onboarding application needs changes. */
  sendOnboardingChangesRequestedEmail(
    recipient: string,
    params: OnboardingChangesRequestedEmailParams,
  ): Promise<void>;
}

/**
 * Dev/test default: logs instead of sending. Never used in
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

  async sendStaffInvitationEmail(invitation: StaffInvitationEmail): Promise<void> {
    this.logger.info('dev_email_staff_invitation', { ...invitation });
  }

  async sendPasswordResetEmail(recipient: string, resetUrl: string): Promise<void> {
    this.logger.info('dev_email_password_reset', { recipient, resetUrl });
  }

  async sendOnboardingChangesRequestedEmail(
    recipient: string,
    params: OnboardingChangesRequestedEmailParams,
  ): Promise<void> {
    // Note text is admin-authored review feedback: log its length, not content.
    this.logger.info('dev_email_onboarding_changes_requested', {
      recipient,
      legalName: params.legalName,
      noteLength: params.note.length,
    });
  }
}
