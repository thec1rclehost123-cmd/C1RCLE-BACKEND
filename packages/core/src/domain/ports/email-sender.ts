import type { Logger } from '../../telemetry/logger.js';

/**
 * ─── EmailSender Port ───────────────────────────────────────────────────────
 * Pluggable interface for outbound transactional email (currently: OTP codes
 * only). Mirrors `payment-provider.ts`'s provider-abstraction pattern — the
 * interface lives here with a safe default; a real implementation (Resend,
 * a GCP-relayed SMTP sender, …) lives in `apps/api-gateway/src/lib/` since it
 * needs `process.env`/network access that `packages/core` may not touch.
 */

export interface EmailSender {
  readonly name: string;
  sendOtpEmail(recipient: string, code: string): Promise<void>;
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
}
