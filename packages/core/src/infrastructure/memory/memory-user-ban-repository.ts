import { VersionConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { UserBan } from '../../domain/models/user-ban.js';
import type { TxContext, UserBanRepository } from '../../domain/ports/repositories.js';

function casSet(store: Map<EntityId, UserBan>, next: UserBan): void {
  const existingVersion = store.get(next.id)?.version ?? 0;
  if (existingVersion !== next.version - 1) {
    throw new VersionConflictError(next.version - 1, existingVersion);
  }
  store.set(next.id, next);
}

/** In-memory adapter for `UserBanRepository`, keyed by user id. */
export class MemoryUserBanRepository implements UserBanRepository {
  bans = new Map<EntityId, UserBan>();

  async getByUserId(userId: EntityId): Promise<UserBan | null> {
    return this.bans.get(userId) ?? null;
  }

  async save(ban: UserBan, _tx?: TxContext | null): Promise<void> {
    casSet(this.bans, ban);
  }
}
