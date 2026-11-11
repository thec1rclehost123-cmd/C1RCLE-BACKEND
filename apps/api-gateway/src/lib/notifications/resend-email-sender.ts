import {
  escapeEmailHtml,
  renderC1rcleBrandHeader,
  renderC1rcleEditorialEyebrow,
  renderC1rcleEmailShell,
  renderC1rclePrimaryCta,
} from '@c1rcle/core/application';
import { PermanentEmailDeliveryError } from '@c1rcle/core/domain';

import type { Logger } from '@c1rcle/core';
import type {
  EmailSender,
  StaffInvitationEmail,
  OnboardingChangesRequestedEmailParams,
  TransactionalEmail,
} from '@c1rcle/core/domain';

/**
 * ─── Resend email sender (auth + transactional delivery) ─────────────────────
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
  readonly localCaptures: {
    deliveryIntentId: string | null;
    sender: string | null;
    recipient: string;
    templateType: string;
    subject: string;
    preheader: string | null;
    html: string;
    text: string | null;
    idempotencyKey: string;
    capturedAt: string;
  }[] = [];

  constructor(
    private readonly apiKey: string | undefined,
    private readonly nodeEnv: 'development' | 'test' | 'production',
    private readonly logger: Logger,
    private readonly fromEmail?: string,
    private readonly nonProductionTestRecipient?: string,
    private readonly enforceTestRecipientAllowlist = false,
  ) {}

  async sendOtpEmail(recipient: string, code: string): Promise<void> {
    this.assertAuthDeliveryAllowed(recipient);
    const rendered = renderBrandedEmail({
      preheader: 'Your C1RCLE access code.',
      eyebrow: 'EMAIL VERIFICATION',
      heading: 'Your access code.',
      bodyHtml: `<p>Use this code for your secure access. It expires in 10 minutes.</p><p style="margin:24px 0;color:#ffffff;font-size:36px;line-height:1.1;font-weight:800;letter-spacing:8px;">${escapeEmailHtml(code)}</p>`,
      bodyText: `This code is for your secure access. It expires in 10 minutes.

${code}`,
    });
    await this.sendAuthEmail(
      recipient,
      'Your Access Key',
      rendered.html,
      rendered.text,
      'Unable to send authorization code.',
    );
  }

  async sendStaffInvitationEmail(invitation: StaffInvitationEmail): Promise<void> {
    this.assertAuthDeliveryAllowed(invitation.to);

    const roleLabel = invitation.role.charAt(0).toUpperCase() + invitation.role.slice(1);
    const details = [
      `You've been invited to join ${invitation.orgName} as ${roleLabel}.`,
      ...invitation.capabilities.map((capability) => `Access: ${capability}.`),
      ...(invitation.temporaryPassword
        ? [
            `Email: ${invitation.to}`,
            `Temporary password: ${invitation.temporaryPassword}`,
            `You'll set your own password the first time you sign in.`,
          ]
        : []),
      `This invite expires on ${invitation.expiresAt}.`,
      ...(invitation.acceptUrl ? [] : ['Ask your manager for the invite link to accept.']),
    ];
    const capabilityHtml = invitation.capabilities.length
      ? `<p style="color:#a0a0a0;">Access: ${invitation.capabilities.map(escapeEmailHtml).join(', ')}.</p>`
      : '';
    const credentialHtml = invitation.temporaryPassword
      ? `<p>Email: <strong>${escapeEmailHtml(invitation.to)}</strong><br />Temporary password: <strong>${escapeEmailHtml(invitation.temporaryPassword)}</strong></p><p>You'll set your own password the first time you sign in.</p>`
      : '';
    const rendered = renderBrandedEmail({
      preheader: `An invitation to join ${invitation.orgName} on THE C1RCLE.`,
      eyebrow: 'STAFF INVITATION',
      heading: "You're invited.",
      bodyHtml: `<p>You've been invited to join <strong>${escapeEmailHtml(invitation.orgName)}</strong> as <strong>${escapeEmailHtml(roleLabel)}</strong>.</p>${capabilityHtml}${credentialHtml}<p>This invite expires on ${escapeEmailHtml(invitation.expiresAt)}.</p>${invitation.acceptUrl ? '' : '<p>Ask your manager for the invite link to accept.</p>'}`,
      bodyText: details.join('\n'),
      ...(invitation.acceptUrl
        ? { action: { url: invitation.acceptUrl, label: 'Accept invite' } }
        : {}),
    });
    await this.sendAuthEmail(
      invitation.to,
      `Join ${invitation.orgName} on THE C1RCLE`,
      rendered.html,
      rendered.text,
      'Unable to send staff invitation.',
    );
  }

  async sendPasswordResetEmail(recipient: string, resetUrl: string): Promise<void> {
    this.assertAuthDeliveryAllowed(recipient);
    const rendered = renderBrandedEmail({
      preheader: 'Choose a new password for your C1RCLE account.',
      eyebrow: 'ACCOUNT SECURITY',
      heading: 'Reset your password.',
      bodyHtml: '<p>Click below to choose a new password. The link expires in 1 hour.</p>',
      bodyText: 'Click below to choose a new password. The link expires in 1 hour.',
      action: { url: resetUrl, label: 'Reset password' },
    });
    await this.sendAuthEmail(
      recipient,
      'Reset your password',
      rendered.html,
      rendered.text,
      'Unable to send password reset email.',
    );
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
    this.assertAuthDeliveryAllowed(recipient);
    const rendered = renderBrandedEmail({
      preheader: 'A reviewer requested changes to your application.',
      eyebrow: 'PARTNER APPLICATION',
      heading: 'One more thing.',
      bodyHtml: `<p>Hi ${escapeEmailHtml(params.legalName)},</p><p>A reviewer asked for changes before your application can proceed:</p><p style="white-space:pre-wrap;">${escapeEmailHtml(params.note)}</p><p>Sign back in to update your application and resubmit.</p>`,
      bodyText: `Hi ${params.legalName},

A reviewer asked for changes before your application can proceed:

${params.note}

Sign back in to update your application and resubmit.`,
    });
    await this.sendAuthEmail(
      recipient,
      'Action needed on your C1RCLE partner application',
      rendered.html,
      rendered.text,
      'Unable to send notification email.',
    );
  }

  async sendTransactionalEmail(message: TransactionalEmail): Promise<{
    outcome: 'accepted_by_provider' | 'captured_locally';
    providerMessageId: string | null;
  }> {
    if (!this.canSendToProvider(message.to)) {
      if (this.nodeEnv === 'production') throw new Error('Email provider not configured');
      this.localCaptures.push({
        deliveryIntentId: message.deliveryIntentId ?? null,
        sender: this.fromEmail ?? null,
        recipient: message.to,
        templateType: message.templateType ?? 'transactional',
        subject: message.subject,
        preheader: message.preheader ?? null,
        html: message.html,
        text: message.text ?? null,
        idempotencyKey: message.idempotencyKey,
        capturedAt: new Date().toISOString(),
      });
      this.logger.info('dev_email_transactional', {
        delivery: 'captured_locally',
        template: message.templateType ?? 'transactional',
      });
      return { outcome: 'captured_locally', providerMessageId: null };
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': message.idempotencyKey,
      },
      body: JSON.stringify({
        from: this.requireFromEmail(),
        to: message.to,
        subject: message.subject,
        html: message.html,
        ...(message.text ? { text: message.text } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      if (
        response.status >= 400 &&
        response.status < 500 &&
        ![408, 409, 429].includes(response.status)
      ) {
        throw new PermanentEmailDeliveryError();
      }
      throw new Error('Email provider temporary rejection');
    }
    const result = (await response.json()) as { id?: unknown };
    if (typeof result.id !== 'string' || !result.id)
      throw new Error('Email provider response missing message id');
    return { outcome: 'accepted_by_provider', providerMessageId: result.id };
  }

  private requireFromEmail(): string {
    if (this.fromEmail) return this.fromEmail;
    throw new Error('Resend sender identity not configured');
  }

  /** Auth flows must never report success when a message was only suppressed. */
  private assertAuthDeliveryAllowed(recipient: string): void {
    if (!this.apiKey) throw new Error('Email provider not configured');
    if (!this.canSendToProvider(recipient)) throw new PermanentEmailDeliveryError();
  }

  private async sendAuthEmail(
    recipient: string,
    subject: string,
    html: string,
    text: string,
    failureMessage: string,
  ): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: this.requireFromEmail(), to: recipient, subject, html, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(failureMessage);
  }

  private canSendToProvider(recipient: string): boolean {
    if (this.enforceTestRecipientAllowlist) {
      const allowed = this.nonProductionTestRecipient?.trim().toLowerCase();
      if (!allowed || recipient.trim().toLowerCase() !== allowed) {
        throw new PermanentEmailDeliveryError();
      }
      return Boolean(this.apiKey);
    }
    if (!this.apiKey) return false;
    if (this.nodeEnv === 'production') return true;
    return (
      this.nonProductionTestRecipient !== undefined &&
      recipient.trim().toLowerCase() === this.nonProductionTestRecipient.trim().toLowerCase()
    );
  }
}

interface BrandedEmailInput {
  preheader: string;
  eyebrow: string;
  heading: string;
  bodyHtml: string;
  bodyText: string;
  action?: { url: string; label: string };
}

function renderBrandedEmail(input: BrandedEmailInput): { html: string; text: string } {
  const actionHtml = input.action
    ? renderC1rclePrimaryCta(input.action.url, input.action.label)
    : '';
  const actionText = input.action
    ? `\n\n${input.action.label.toUpperCase()}: ${input.action.url}`
    : '';
  const rows = `${renderC1rcleBrandHeader()}${renderC1rcleEditorialEyebrow(input.eyebrow)}<tr><td style="padding:10px 24px 12px;"><h1 style="margin:0;color:#ffffff;font-size:36px;line-height:1.04;font-weight:800;letter-spacing:-1.1px;">${escapeEmailHtml(input.heading)}</h1></td></tr><tr><td style="padding:0 24px 26px;color:#c7c7c7;font-size:15px;line-height:1.65;">${input.bodyHtml}</td></tr>${actionHtml}<tr><td style="padding:20px 24px 30px;border-top:1px solid #292929;color:#777777;font-size:12px;line-height:1.6;"><strong style="color:#b6b6b6;letter-spacing:2px;font-size:10px;">THE C1RCLE</strong></td></tr>`;
  return {
    html: renderC1rcleEmailShell(input.preheader, rows),
    text: `THE C1RCLE\n\n${input.heading}\n\n${input.bodyText}${actionText}\n\nTHE C1RCLE`,
  };
}
