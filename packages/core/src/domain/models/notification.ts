import type { EntityId } from '../identity.js';

/**
 * ─── V2 notification aggregate ────────────────────────────────────────────────
 * The partner-dashboard inbox, ported from v1's `notifications/{hostId}/...`
 * collection to the V2 tenant model: recipients are ORGANIZATIONS, not people.
 * `recipientId` is always an `organizationId` and `recipientType` describes
 * that org's kind, so one collection serves the venue, host and promoter
 * dashboards and the RBAC check is exactly `actor.organizationId`.
 *
 * An optional `action` links the notification to the resource the inbox offers
 * a quick approve/reject on (a promoter connection / partnership / slot
 * request). `dedupeKey` lets producers suppress repeated notifications about
 * the same thing (a recapture is not a fresh alert).
 */

/** Which kind of org the notification is addressed to. Mirrors `Capability`. */
export type NotificationRecipientType = 'venue' | 'host' | 'promoter';

/** The resource a quick inbox action operates on. */
export type NotificationActionType = 'promoter_connection' | 'partnership' | 'slot_request';

export type NotificationPriority = 'normal' | 'high';

export interface NotificationAction {
  resourceType: NotificationActionType;
  resourceId: EntityId;
}

export interface Notification {
  id: EntityId;
  recipientId: EntityId;
  recipientType: NotificationRecipientType;
  /** Domain-local type, e.g. `promoter_connection.requested`. */
  type: string;
  title: string;
  body: string;
  read: boolean;
  /** ISO-8601; null until the notification is read. */
  readAt: string | null;
  data: Record<string, unknown>;
  action: NotificationAction | null;
  priority: NotificationPriority;
  dedupeKey: string | null;
  /** ISO-8601 (injected clock). */
  createdAt: string;
}

export interface CreateNotificationInput {
  id: EntityId;
  recipientId: EntityId;
  recipientType: NotificationRecipientType;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  action?: NotificationAction;
  priority?: NotificationPriority;
  dedupeKey?: string;
  now: Date;
}

export function createNotification(input: CreateNotificationInput): Notification {
  return {
    id: input.id,
    recipientId: input.recipientId,
    recipientType: input.recipientType,
    type: input.type,
    title: input.title,
    body: input.body,
    read: false,
    readAt: null,
    data: input.data ?? {},
    action: input.action ?? null,
    priority: input.priority ?? 'normal',
    dedupeKey: input.dedupeKey ?? null,
    createdAt: input.now.toISOString(),
  };
}

/** Canonical read transition — idempotent (`read: true, readAt` unchanged). */
export function markNotificationRead(notification: Notification, now: Date): Notification {
  if (notification.read) return notification;
  return { ...notification, read: true, readAt: now.toISOString() };
}
