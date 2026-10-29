import { VersionConflictError } from '../../domain/errors.js';
import { DEFAULT_JOURNAL_TRANSITION_STATE } from '../../domain/models/journal-transition.js';

import type { JournalTransitionState } from '../../domain/models/journal-transition.js';
import type { JournalTransitionRepository } from '../../domain/ports/repositories.js';
import type { Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_financial_journal_transition';
const DOCUMENT = 'singleton';

export class FirestoreJournalTransitionRepository implements JournalTransitionRepository {
  constructor(private readonly db: Firestore) {}

  async get(): Promise<JournalTransitionState> {
    const snapshot = await this.db.collection(COLLECTION).doc(DOCUMENT).get();
    return snapshot.exists
      ? (snapshot.data() as JournalTransitionState)
      : { ...DEFAULT_JOURNAL_TRANSITION_STATE };
  }

  async save(state: JournalTransitionState): Promise<void> {
    const reference = this.db.collection(COLLECTION).doc(DOCUMENT);
    await this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(reference);
      const currentVersion = snapshot.exists
        ? (snapshot.data()?.version as number)
        : DEFAULT_JOURNAL_TRANSITION_STATE.version;
      if (state.version !== currentVersion + 1) {
        throw new VersionConflictError(state.version - 1, currentVersion);
      }
      tx.set(reference, state);
    });
  }
}
