import { markNotificationRead } from '../../domain/models/notification.js';

import { sliceArray } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { Notification } from '../../domain/models/notification.js';
import type {
  NotificationRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

/**
 * `v2_notifications` — the partner-dashboard inbox, per this repo's `v2_`
 * prefix convention. v1 used `notifications/{recipientId}/items/{id}`; V2
 * flattens to a single tenant-keyed collection (recipient = organization), so
 * an org's inbox is one equality query instead of a composite path.
 *
 * Lists sort in memory after a single `where('recipientId')` query, mirroring
 * the venue overlapping-slots adapter: sorting newest-first would otherwise
 * need a composite `recipientId + createdAt` index that cannot be provisioned
 * here (and this repo's FGM/contract fixture would diverge). Inbox volumes
 * per org are bounded (a handful to low hundreds), so materializing +
 * sorting is fine.
 */
const COLLECTION = 'v2_notifications';

export class FirestoreNotificationRepository implements NotificationRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  async create(notification: Notification, _tx?: TxContext | null): Promise<void> {
    await this.collection.doc(notification.id).set(toDoc(notification));
  }

  async save(notification: Notification, _tx?: TxContext | null): Promise<void> {
    await this.collection.doc(notification.id).set(toDoc(notification));
  }

  async getById(notificationId: EntityId): Promise<Notification | null> {
    const snap = await this.collection.doc(notificationId).get();
    const data = snap.data();
    return data ? toNotification(data) : null;
  }

  async listByRecipient(
    recipientId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Notification>> {
    const snap = await this.collection.where('recipientId', '==', recipientId).get();
    const rows = snap.docs
      .map((doc) => toNotification(doc.data()))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return sliceArray(rows, query);
  }

  async listUnreadByRecipient(
    recipientId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Notification>> {
    const snap = await this.collection
      .where('recipientId', '==', recipientId)
      .where('read', '==', false)
      .get();
    const rows = snap.docs
      .map((doc) => toNotification(doc.data()))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return sliceArray(rows, query);
  }

  async markRead(notificationId: EntityId, nowIso: string): Promise<Notification | null> {
    const current = await this.getById(notificationId);
    if (!current) return null;
    const updated = markNotificationRead(current, new Date(nowIso));
    await this.collection.doc(notificationId).set(toDoc(updated));
    return updated;
  }

  async markAllRead(recipientId: EntityId, nowIso: string): Promise<number> {
    const snap = await this.collection
      .where('recipientId', '==', recipientId)
      .where('read', '==', false)
      .get();
    if (snap.empty) return 0;
    const now = new Date(nowIso).toISOString();
    const batch = this.db.batch();
    for (const doc of snap.docs) {
      batch.update(doc.ref, { read: true, readAt: now });
    }
    await batch.commit();
    return snap.size;
  }

  async countUnread(recipientId: EntityId): Promise<number> {
    const countSnap = await this.collection
      .where('recipientId', '==', recipientId)
      .where('read', '==', false)
      .count()
      .get();
    return countSnap.data().count;
  }
}

function toDoc(notification: Notification): DocumentData {
  return {
    id: notification.id,
    recipientId: notification.recipientId,
    recipientType: notification.recipientType,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    read: notification.read,
    readAt: notification.readAt,
    data: notification.data,
    action: notification.action,
    priority: notification.priority,
    dedupeKey: notification.dedupeKey,
    createdAt: notification.createdAt,
  };
}

function toNotification(data: DocumentData): Notification {
  const action = data.action as Notification['action'] | null;
  const rawData = (data.data ?? {}) as Record<string, unknown>;
  return {
    id: data.id as string,
    recipientId: data.recipientId as string,
    recipientType: data.recipientType as Notification['recipientType'],
    type: data.type as string,
    title: data.title as string,
    body: data.body as string,
    read: (data.read as boolean) ?? false,
    readAt: (data.readAt ?? null) as string | null,
    data: rawData,
    action: action ?? null,
    priority: (data.priority ?? 'normal') as Notification['priority'],
    dedupeKey: (data.dedupeKey ?? null) as string | null,
    createdAt: data.createdAt as string,
  };
}
