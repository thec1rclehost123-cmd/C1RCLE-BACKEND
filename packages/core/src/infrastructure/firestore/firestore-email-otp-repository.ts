import { normalizeEmailRecipient } from '../../domain/models/email-otp.js';

import type { EntityId } from '../../domain/identity.js';
import type { EmailOtp } from '../../domain/models/email-otp.js';
import type { EmailOtpRepository } from '../../domain/ports/repositories.js';
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
}

function toDoc(otp: EmailOtp): DocumentData {
  return {
    recipient: otp.recipient,
    codeHash: otp.codeHash,
    expiresAt: otp.expiresAt,
    lastSentAt: otp.lastSentAt,
    attempts: otp.attempts,
  };
}

function toEmailOtp(data: DocumentData): EmailOtp {
  return {
    recipient: data.recipient as string,
    codeHash: data.codeHash as string,
    expiresAt: data.expiresAt as string,
    lastSentAt: data.lastSentAt as string,
    attempts: data.attempts as number,
  };
}
