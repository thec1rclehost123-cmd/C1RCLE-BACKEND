import { InvalidOperationError } from '../../domain/errors.js';
import { normalizeEmailRecipient } from '../../domain/models/email-otp.js';

import type { EntityId } from '../../domain/identity.js';
import type { EmailOtp } from '../../domain/models/email-otp.js';
import type { EmailOtpRepository, EmailOtpTransition } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

/**
 * v1 used `otps/auth_{recipient}` in a shared `otps` collection; V2 gets its
 * own `v2_email_otps` collection per this repo's `v2_`-prefix convention —
 * no cross-version collision, no risk of a stale v1 doc being read as V2's.
 */
const EMAIL_OTP_COLLECTION = 'v2_email_otps';

export class FirestoreEmailOtpRepository implements EmailOtpRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(EMAIL_OTP_COLLECTION);
  }

  async get(recipient: EntityId): Promise<EmailOtp | null> {
    const data = (await this.collection.doc(normalizeEmailRecipient(recipient)).get()).data();
    return data ? toEmailOtp(data) : null;
  }

  async save(otp: EmailOtp): Promise<void> {
    await this.collection.doc(otp.recipient).set(toDoc(otp));
  }

  async delete(recipient: EntityId): Promise<void> {
    await this.collection.doc(normalizeEmailRecipient(recipient)).delete();
  }

  async updateAtomically<T>(
    recipient: EntityId,
    transition: (current: EmailOtp | null) => EmailOtpTransition<T>,
  ): Promise<T> {
    const ref = this.collection.doc(normalizeEmailRecipient(recipient));
    return this.db.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data();
      const current = data ? toEmailOtp(data) : null;
      const { next, result, verifyAccountAt } = transition(current);
      if (verifyAccountAt !== undefined) {
        if (next !== null || !current?.userId) {
          throw new InvalidOperationError(
            'Verification account no longer matches. Request a new code.',
          );
        }
        const userRef = this.db.collection('v2_auth_users').doc(current.userId);
        const account = (await tx.get(userRef)).data();
        if (!account || account.email !== normalizeEmailRecipient(recipient)) {
          throw new InvalidOperationError(
            'Verification account no longer matches. Request a new code.',
          );
        }
        tx.update(userRef, { emailVerified: true, updatedAt: new Date(verifyAccountAt) });
      }
      if (next !== current) {
        if (next) tx.set(ref, toDoc(next));
        else if (current) tx.delete(ref);
      }
      return result;
    });
  }
}

function toDoc(otp: EmailOtp): DocumentData {
  return {
    recipient: otp.recipient,
    ...(otp.userId ? { userId: otp.userId } : {}),
    codeHash: otp.codeHash,
    expiresAt: otp.expiresAt,
    lastSentAt: otp.lastSentAt,
    attempts: otp.attempts,
  };
}

function toEmailOtp(data: DocumentData): EmailOtp {
  return {
    recipient: data.recipient as string,
    ...(typeof data.userId === 'string' ? { userId: data.userId } : {}),
    codeHash: data.codeHash as string,
    expiresAt: data.expiresAt as string,
    lastSentAt: data.lastSentAt as string,
    attempts: data.attempts as number,
  };
}
