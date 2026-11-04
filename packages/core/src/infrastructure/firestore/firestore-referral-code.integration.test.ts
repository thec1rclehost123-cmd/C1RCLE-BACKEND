import { createHash, randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import { FirestoreReferralLinkRepository } from './firestore-referral-link-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const CODE_COLLECTION = 'v2_promoter_tracking_codes';
const ASSIGNMENT_CODE_COLLECTION = 'v2_promoter_assignment_codes';
const EVENT_CODE_CLAIM_COLLECTION = 'v2_promoter_event_code_claims';

describe.runIf(EMULATOR)('Promoter assignment code reservations (Firestore emulator)', () => {
  let db: Firestore;

  beforeAll(() => {
    db = new Firestore({ projectId: 'demo-c1rcle' });
  });

  it('reserves a code once per assignment and prevents a second assignment claiming it', async () => {
    const token = randomUUID().replaceAll('-', '').toUpperCase();
    const eventId = `m4-event-${token}`;
    const promoterId = `m4-promoter-${token}`;
    const firstAssignmentId = `m4-assignment-a-${token}`;
    const secondAssignmentId = `m4-assignment-b-${token}`;
    const code = `M4${token.slice(0, 8)}`;
    const claimId = createHash('sha256').update(`${eventId}\u0000${code}`).digest('hex');
    const repo = new FirestoreReferralLinkRepository(db);

    try {
      const concurrent = await Promise.all([
        repo.getOrCreateAssignmentCode(firstAssignmentId, eventId, promoterId, code),
        repo.getOrCreateAssignmentCode(firstAssignmentId, eventId, promoterId, code),
      ]);
      expect(concurrent).toEqual([code, code]);
      expect(
        await repo.getOrCreateAssignmentCode(firstAssignmentId, eventId, promoterId, 'M4RETRY'),
      ).toBe(code);
      expect(
        await repo.getOrCreateAssignmentCode(secondAssignmentId, eventId, promoterId, code),
      ).toBeNull();
    } finally {
      await Promise.all([
        db.collection(ASSIGNMENT_CODE_COLLECTION).doc(firstAssignmentId).delete(),
        db.collection(ASSIGNMENT_CODE_COLLECTION).doc(secondAssignmentId).delete(),
        db.collection(EVENT_CODE_CLAIM_COLLECTION).doc(claimId).delete(),
        db.collection(CODE_COLLECTION).doc(code).delete(),
      ]);
    }
  }, 45_000);
});
