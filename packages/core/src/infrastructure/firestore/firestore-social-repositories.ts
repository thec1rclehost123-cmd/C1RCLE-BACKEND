import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { Follow, FollowTargetType, Notification } from '../../domain/models/social.js';
import type {
  FollowRepository,
  NotificationRepository,
  Page,
  PaginationQuery,
} from '../../domain/ports/repositories.js';
import type { DocumentData, DocumentReference, Firestore } from 'firebase-admin/firestore';

/**
 * ─── Phase 8 Firestore adapters ──────────────────────────────────────────────
 * `v2_follows`: one doc per edge, id = `followId(...)`, so follow is an
 * idempotent `set` and unfollow an idempotent `delete`.
 * `v2_notifications`: one doc per (recipient, type, subject); `create()` is
 * the consumer idempotency guard (ALREADY_EXISTS → no-op, never overwrite a
 * read row). Read state lives on the row (`readAt`) rather than in v1's
 * separate `notification_reads` collection: every v2 notification has exactly
 * one recipient, so a join collection buys nothing.
 * Composite indexes for the ordered queries live in `firestore.indexes.json`.
 */
const FOLLOW_COLLECTION = 'v2_follows';
const NOTIFICATION_COLLECTION = 'v2_notifications';
/** Firestore batch write limit. */
const BATCH_LIMIT = 500;

export class FirestoreFollowRepository implements FollowRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(FOLLOW_COLLECTION);
  }

  async get(id: EntityId): Promise<Follow | null> {
    const data = (await this.collection.doc(id).get()).data();
    return data ? toFollow(data) : null;
  }

  async save(follow: Follow): Promise<void> {
    await this.collection.doc(follow.id).set({ ...follow });
  }

  async delete(id: EntityId): Promise<boolean> {
    const ref = this.collection.doc(id);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.delete();
    return true;
  }

  listByFollower(
    followerId: EntityId,
    query: PaginationQuery & { targetType?: FollowTargetType },
  ): Promise<Page<Follow>> {
    let base = this.collection.where('followerId', '==', followerId);
    if (query.targetType) base = base.where('targetType', '==', query.targetType);
    return paginateQuery(base.orderBy('createdAt', 'desc'), query, toFollow);
  }

  listFollowers(
    targetType: FollowTargetType,
    targetId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Follow>> {
    const base = this.collection
      .where('targetType', '==', targetType)
      .where('targetId', '==', targetId)
      .orderBy('createdAt', 'desc');
    return paginateQuery(base, query, toFollow);
  }

  async countFollowers(targetType: FollowTargetType, targetId: EntityId): Promise<number> {
    const snap = await this.collection
      .where('targetType', '==', targetType)
      .where('targetId', '==', targetId)
      .count()
      .get();
    return snap.data().count;
  }
}

export class FirestoreNotificationRepository implements NotificationRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(NOTIFICATION_COLLECTION);
  }

  async createIfAbsent(notification: Notification): Promise<boolean> {
    try {
      await this.collection.doc(notification.id).create({ ...notification });
      return true;
    } catch (error: unknown) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
  }

  listForUser(
    userId: EntityId,
    query: PaginationQuery & { unreadOnly?: boolean },
  ): Promise<Page<Notification>> {
    let base = this.collection.where('userId', '==', userId);
    if (query.unreadOnly) base = base.where('readAt', '==', null);
    return paginateQuery(base.orderBy('createdAt', 'desc'), query, toNotification);
  }

  async countUnread(userId: EntityId): Promise<number> {
    const snap = await this.collection
      .where('userId', '==', userId)
      .where('readAt', '==', null)
      .count()
      .get();
    return snap.data().count;
  }

  async markRead(userId: EntityId, ids: EntityId[], readAt: string): Promise<number> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return 0;
    const snaps = await this.db.getAll(...unique.map((id) => this.collection.doc(id)));
    // Ownership + unread checked here: someone else's id is silently skipped,
    // never a hint that the row exists.
    const refs = snaps
      .filter((s) => s.exists && s.get('userId') === userId && s.get('readAt') === null)
      .map((s) => s.ref);
    await this.commitReadAt(refs, readAt);
    return refs.length;
  }

  async markAllRead(userId: EntityId, readAt: string): Promise<number> {
    const snap = await this.collection
      .where('userId', '==', userId)
      .where('readAt', '==', null)
      .get();
    const refs = snap.docs.map((d) => d.ref);
    await this.commitReadAt(refs, readAt);
    return refs.length;
  }

  private async commitReadAt(refs: DocumentReference[], readAt: string): Promise<void> {
    for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
      const batch = this.db.batch();
      for (const ref of refs.slice(i, i + BATCH_LIMIT)) batch.update(ref, { readAt });
      await batch.commit();
    }
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 6;
}

function toFollow(data: DocumentData): Follow {
  return {
    id: data.id as string,
    followerId: data.followerId as string,
    targetType: data.targetType as FollowTargetType,
    targetId: data.targetId as string,
    createdAt: data.createdAt as string,
  };
}

function toNotification(data: DocumentData): Notification {
  return {
    id: data.id as string,
    userId: data.userId as string,
    type: data.type as Notification['type'],
    title: data.title as string,
    body: data.body as string,
    link: (data.link as string | null) ?? null,
    subjectId: data.subjectId as string,
    createdAt: data.createdAt as string,
    readAt: (data.readAt as string | null) ?? null,
  };
}
