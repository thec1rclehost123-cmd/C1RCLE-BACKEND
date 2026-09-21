import { compareAndSet } from './compare-and-set.js';

import type { EntityId } from '../../domain/identity.js';
import type { UserBan } from '../../domain/models/user-ban.js';
import type { TxContext, UserBanRepository } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_user_bans';

/** Firestore adapter for `UserBanRepository`, keyed by user id. */
export class FirestoreUserBanRepository implements UserBanRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async getByUserId(userId: EntityId): Promise<UserBan | null> {
    const data = (await this.collection.doc(userId).get()).data();
    return data ? toUserBan(data) : null;
  }

  async save(ban: UserBan, _tx?: TxContext | null): Promise<void> {
    await compareAndSet(this.db, this.collection, ban, (entity) => ({ ...entity }));
  }
}

function toUserBan(data: DocumentData): UserBan {
  return {
    id: data.id as string,
    userId: data.userId as string,
    isBanned: data.isBanned as boolean,
    bannedAt: (data.bannedAt as string | null) ?? null,
    bannedBy: (data.bannedBy as string | null) ?? null,
    banReason: (data.banReason as string | null) ?? null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
