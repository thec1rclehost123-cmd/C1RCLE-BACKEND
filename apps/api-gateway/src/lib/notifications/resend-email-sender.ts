import type { Logger } from '@c1rcle/core';
import type {
  EmailSender,
  OnboardingChangesRequestedEmailParams,
  StaffInvitationEmail,
} from '@c1rcle/core/domain';

/**
 * ─── Resend email sender (OTP + staff-invitation delivery) ───────────────────
 * Ported from v1's `guest-otp.ts` `sendEmail` — same provider, same template
 * intent, same fail-closed rule: without `RESEND_API_KEY` this throws in
 * production rather than silently no-op'ing (checked at send time, not at
 * gateway boot — an unconfigured key must not stop the whole gateway from
 * starting, only the send itself, same as v1's `validateOtpConfig`
 * being called per-request rather than at process start).
 *
 * Plan note: the roadmap calls for GCP-relayed SMTP as the eventual
 * transport — this Resend adapter is the proven v1 baseline wired first;
 * swapping the transport only touches this file, `EmailSender` callers are
 * unaffected.
 */
export class ResendEmailSender implements EmailSender {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string | undefined,
    private readonly nodeEnv: 'development' | 'test' | 'production',
    private readonly logger: Logger,
  ) {}

  async sendOtpEmail(recipient: string, code: string): Promise<void> {
    if (!this.apiKey) {
      if (this.nodeEnv === 'production') {
        throw new Error('Email provider not configured');
      }
      this.logger.info('dev_email_otp', { recipient, code });
      return;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'noreply@thec1rcle.com',
        to: recipient,
        subject: 'Your Access Key',
        html: `
                <div style="background-color:#000;color:#fff;padding:40px;font-family:sans-serif;text-align:center;">
                    <h1 style="color:#FF5A00;text-transform:uppercase;letter-spacing:5px;">THE C1RCLE</h1>
                    <p style="text-transform:uppercase;letter-spacing:2px;color:#666;font-size:12px;">Identity Authorization</p>
                    <div style="margin:40px 0;font-size:48px;font-weight:900;letter-spacing:10px;color:#fff;">${code}</div>
                    <p style="color:#666;font-size:10px;text-transform:uppercase;">This code is for your secure access.<br/>It will expire in 10 minutes.</p>
                </div>
            `,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(errorData.message ?? 'Unable to send authorization code.');
    }
  }

  async sendStaffInvitationEmail(invitation: StaffInvitationEmail): Promise<void> {
    if (!this.apiKey) {
      if (this.nodeEnv === 'production') {
        throw new Error('Email provider not configured');
      }
      this.logger.info('dev_email_staff_invitation', { ...invitation });
      return;
    }

    const roleLabel = invitation.role.charAt(0).toUpperCase() + invitation.role.slice(1);
    const capabilityLine =
      invitation.capabilities.length > 0 ? `Access: ${invitation.capabilities.join(', ')}.` : null;
    const expiresLine = `This invite expires on ${invitation.expiresAt}.`;
    const credentialsBlock = invitation.temporaryPassword
      ? `<div style="margin:24px 0;padding:20px;border:1px solid #333;text-align:left;">
           <p style="color:#999;font-size:10px;text-transform:uppercase;letter-spacing:2px;margin:0 0 12px;">Your sign-in credentials</p>
           <p style="font-size:14px;margin:6px 0;">Email: <strong>${invitation.to}</strong></p>
           <p style="font-size:14px;margin:6px 0;">Temporary password: <strong style="letter-spacing:2px;">${invitation.temporaryPassword}</strong></p>
           <p style="color:#999;font-size:11px;">You'll set your own password the first time you sign in.</p>
         </div>`
      : '';
    // One hero CTA by design: the accept page signs the invitee in (email
    // prefilled), walks the first-login rotation, then finishes the accept
    // itself — no second button to wonder about.
    const actionBlock = invitation.acceptUrl
      ? `<a href="${invitation.acceptUrl}" style="display:inline-block;margin:32px 0;padding:14px 32px;background-color:#FF5A00;color:#fff;text-decoration:none;text-transform:uppercase;letter-spacing:2px;font-size:12px;font-weight:700;">Accept invite</a>
         <p style="color:#666;font-size:10px;">If the button doesn't work, open this link:<br/>${invitation.acceptUrl}</p>`
      : `<p style="color:#666;font-size:10px;text-transform:uppercase;">Ask your manager for the invite link to accept.</p>`;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'noreply@thec1rcle.com',
        to: invitation.to,
        subject: `Join ${invitation.orgName} on THE C1RCLE`,
        html: `
                <div style="background-color:#000;color:#fff;padding:40px;font-family:sans-serif;text-align:center;">
                    <h1 style="color:#FF5A00;text-transform:uppercase;letter-spacing:5px;">THE C1RCLE</h1>
                    <p style="text-transform:uppercase;letter-spacing:2px;color:#666;font-size:12px;">Team invitation</p>
                    <p style="font-size:16px;">You've been invited to join <strong>${invitation.orgName}</strong> as <strong>${roleLabel}</strong>.</p>
                    ${capabilityLine ? `<p style="color:#999;font-size:12px;">${capabilityLine}</p>` : ''}
                    ${credentialsBlock}
                    ${actionBlock}
                    <p style="color:#666;font-size:10px;text-transform:uppercase;">${expiresLine}</p>
                </div>
            `,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(errorData.message ?? 'Unable to send staff invitation.');
    }
  }

  async sendPasswordResetEmail(recipient: string, resetUrl: string): Promise<void> {
    if (!this.apiKey) {
      if (this.nodeEnv === 'production') {
        throw new Error('Email provider not configured');
      }
      this.logger.info('dev_email_password_reset', { recipient, resetUrl });
      return;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'noreply@thec1rcle.com',
        to: recipient,
        subject: 'Reset your password',
        html: `
                <div style="background-color:#000;color:#fff;padding:40px;font-family:sans-serif;text-align:center;">
                    <h1 style="color:#FF5A00;text-transform:uppercase;letter-spacing:5px;">THE C1RCLE</h1>
                    <p style="text-transform:uppercase;letter-spacing:2px;color:#666;font-size:12px;">Password Reset</p>
                    <p style="color:#fff;font-size:16px;margin:24px 0;">Click below to choose a new password. The link expires in 1 hour.</p>
                    <a href="${resetUrl}" style="display:inline-block;background:#FF5A00;color:#fff;text-transform:uppercase;letter-spacing:2px;font-size:14px;font-weight:700;padding:16px 32px;text-decoration:none;border-radius:6px;">Reset password</a>
                </div>
            `,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(errorData.message ?? 'Unable to send password reset email.');
    }
  }

  /**
   * Notifies an onboarding applicant that an admin asked for changes. Same
   * fail-closed/dev-logging split as `sendOtpEmail`; callers (the onboarding
   * service) log-and-swallow a throw here rather than propagate it.
   */
  async sendOnboardingChangesRequestedEmail(
    recipient: string,
    params: OnboardingChangesRequestedEmailParams,
  ): Promise<void> {
    if (!this.apiKey) {
      if (this.nodeEnv === 'production') {
        throw new Error('Email provider not configured');
      }
      this.logger.info('dev_email_onboarding_changes_requested', {
        recipient,
        legalName: params.legalName,
        noteLength: params.note.length,
      });
      return;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'noreply@thec1rcle.com',
        to: recipient,
        subject: 'Action needed on your C1RCLE partner application',
        html: `
                <div style="background-color:#000;color:#fff;padding:40px;font-family:sans-serif;text-align:center;">
                    <h1 style="color:#FF5A00;text-transform:uppercase;letter-spacing:5px;">THE C1RCLE</h1>
                    <p style="text-transform:uppercase;letter-spacing:2px;color:#666;font-size:12px;">Partner Application</p>
                    <p style="color:#fff;font-size:16px;margin:24px 0 8px;">Hi ${escapeHtml(params.legalName)},</p>
                    <p style="color:#ccc;font-size:14px;">A reviewer asked for changes before your application can proceed:</p>
                    <div style="margin:24px 0;padding:16px;background:#111;color:#fff;font-size:14px;text-align:left;white-space:pre-wrap;">${escapeHtml(params.note)}</div>
                    <p style="color:#666;font-size:10px;text-transform:uppercase;">Sign back in to update your application and resubmit.</p>
                </div>
            `,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(errorData.message ?? 'Unable to send notification email.');
    }
  }
}

/** Minimal HTML-escaping for admin-authored text interpolated into the email body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
