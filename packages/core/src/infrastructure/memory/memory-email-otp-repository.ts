import { InvalidOperationError } from '../../domain/errors.js';
import { normalizeEmailRecipient } from '../../domain/models/email-otp.js';

import { type MemoryUserAccountRepository } from './memory-user-account-repository.js';

import type { EntityId } from '../../domain/identity.js';
import type { EmailOtp } from '../../domain/models/email-otp.js';
import type { EmailOtpRepository, EmailOtpTransition } from '../../domain/ports/repositories.js';

export class MemoryEmailOtpRepository implements EmailOtpRepository {
  constructor(private readonly users: MemoryUserAccountRepository) {}

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

  async updateAtomically<T>(
    recipient: EntityId,
    transition: (current: EmailOtp | null) => EmailOtpTransition<T>,
  ): Promise<T> {
    const key = normalizeEmailRecipient(recipient);
    const existing = this.entries.get(key);
    // No await between the read, transition and write: one event-loop turn.
    const { next, result, verifyAccountAt } = transition(existing ? { ...existing } : null);
    if (verifyAccountAt !== undefined) {
      const account = existing?.userId ? this.users.users.get(existing.userId) : undefined;
      if (next !== null || !account || account.email !== key) {
        throw new InvalidOperationError(
          'Verification account no longer matches. Request a new code.',
        );
      }
      this.users.save({ ...account, emailVerified: true, updatedAt: Date.parse(verifyAccountAt) });
    }
    if (next) this.entries.set(key, { ...next });
    else this.entries.delete(key);
    return result;
  }
}
