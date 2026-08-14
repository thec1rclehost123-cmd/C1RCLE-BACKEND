import { VersionConflictError } from '../../domain/errors.js';

import type { VersionedEntity } from '../../domain/identity.js';
import type { CollectionReference, DocumentData, Firestore } from 'firebase-admin/firestore';

/**
 * ─── Compare-and-set for versioned aggregates (closes the D-002 gap) ─────────
 *
 * Services check `expectedVersion` before writing, but a check-then-write is
 * not atomic: two callers can both read version 1, both pass the check, and
 * both write version 2 — the second silently erasing the first. `If-Match`
 * looks enforced while lost updates happen anyway.
 *
 * This closes it in the adapter, where the atomicity actually exists. The rule
 * comes free from the domain: `bumpVersion` always increments by exactly one,
 * so **a write of version N must find version N-1 in storage**. Enforcing that
 * inside a Firestore transaction makes a lost update impossible even for a
 * service that forgot to check.
 *
 * Version 1 is exempt: a create has no predecessor, and ids are generated, so
 * two concurrent creates of the same id is not a real scenario. Keeping
 * creates as a plain `set` also leaves seeding and re-seeding idempotent.
 */
export async function compareAndSet<T extends VersionedEntity & { id: string }>(
  db: Firestore,
  collection: CollectionReference,
  entity: T,
  toDoc: (entity: T) => DocumentData,
): Promise<void> {
  const ref = collection.doc(entity.id);

  if (entity.version <= 1) {
    await ref.set(toDoc(entity));
    return;
  }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const stored = snap.data();

    // A missing document under a version > 1 means the row was deleted (or
    // never existed) while the caller held it — the write it based its
    // decision on is gone, which is the same failure a stale version is.
    if (!stored) {
      throw new VersionConflictError(entity.version - 1, 0);
    }

    const storedVersion = Number(stored.version ?? 0);
    if (storedVersion !== entity.version - 1) {
      // Report what the caller must re-fetch, not what they sent: the client
      // needs the version that actually won.
      throw new VersionConflictError(entity.version - 1, storedVersion);
    }

    tx.set(ref, toDoc(entity));
  });
}
