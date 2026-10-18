import { VersionConflictError } from '../../domain/errors.js';
import { DEFAULT_JOURNAL_TRANSITION_STATE } from '../../domain/models/journal-transition.js';

import type { JournalTransitionState } from '../../domain/models/journal-transition.js';
import type { JournalTransitionRepository } from '../../domain/ports/repositories.js';

export class MemoryJournalTransitionRepository implements JournalTransitionRepository {
  state: JournalTransitionState = { ...DEFAULT_JOURNAL_TRANSITION_STATE };

  async get(): Promise<JournalTransitionState> {
    return structuredClone(this.state);
  }

  async save(state: JournalTransitionState): Promise<void> {
    if (state.version !== this.state.version + 1) {
      throw new VersionConflictError(state.version - 1, this.state.version);
    }
    this.state = structuredClone(state);
  }
}
