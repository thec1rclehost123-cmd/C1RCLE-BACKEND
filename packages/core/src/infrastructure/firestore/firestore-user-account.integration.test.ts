import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { FirestoreUserAccountRepository } from './firestore-user-account-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('verified user identity (Firestore emulator)', () => {
  it('reads persisted Better Auth email verification and defaults missing values to false', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const suffix = randomUUID();
    const verifiedId = `m5-verified-${suffix}`;
    const unverifiedId = `m5-unverified-${suffix}`;
    const collection = db.collection('v2_auth_users');
    const now = new Date();
    const repo = new FirestoreUserAccountRepository(db);

    try {
      await Promise.all([
        collection.doc(verifiedId).set({
          email: `${verifiedId}@example.test`,
          name: 'Disposable verified account',
          emailVerified: true,
          role: 'guest',
          createdAt: now,
          updatedAt: now,
        }),
        collection.doc(unverifiedId).set({
          email: `${unverifiedId}@example.test`,
          name: 'Disposable legacy account',
          role: 'guest',
          createdAt: now,
          updatedAt: now,
        }),
      ]);

      await expect(repo.getById(verifiedId)).resolves.toMatchObject({
        id: verifiedId,
        emailVerified: true,
      });
      await expect(repo.getById(unverifiedId)).resolves.toMatchObject({
        id: unverifiedId,
        emailVerified: false,
      });
    } finally {
      await Promise.all([
        collection.doc(verifiedId).delete(),
        collection.doc(unverifiedId).delete(),
      ]);
      await db.terminate();
    }
  }, 30_000);
});
