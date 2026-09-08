import type { Logger } from '@c1rcle/core';
import type { EmailSender } from '@c1rcle/core/domain';

/**
 * ─── Resend email sender (OTP delivery) ──────────────────────────────────────
 * Ported from v1's `guest-otp.ts` `sendEmail` — same provider, same template
 * intent, same fail-closed rule: without `RESEND_API_KEY` this throws in
 * production rather than silently no-op'ing (checked at send time, not at
 * gateway boot — an unconfigured key must not stop the whole gateway from
 * starting, only the OTP-send route itself, same as v1's `validateOtpConfig`
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
}
