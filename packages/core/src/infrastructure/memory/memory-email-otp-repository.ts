import { normalizeEmailRecipient } from '../../domain/models/email-otp.js';

import type { EntityId } from '../../domain/identity.js';
import type { EmailOtp } from '../../domain/models/email-otp.js';
import type { EmailOtpRepository } from '../../domain/ports/repositories.js';

export class MemoryEmailOtpRepository implements EmailOtpRepository {
  entries = new Map<string, EmailOtp>();

  async get(recipient: EntityId): Promise<EmailOtp | null> {
    return this.entries.get(normalizeEmailRecipient(recipient)) ?? null;
  }

  async save(otp: EmailOtp): Promise<void> {
    this.entries.set(otp.recipient, otp);
  }

  async delete(recipient: EntityId): Promise<void> {
    this.entries.delete(normalizeEmailRecipient(recipient));
  }
}
