import { createHash } from 'node:crypto';

import { InvalidOperationError } from '../errors.js';

import type { EntityId } from '../identity.js';

/**
 * ─── Phase 8: follow graph + in-app notifications ───────────────────────────
 * v1 kept the follow graph in four collections (`follows`,
 * `userFollows/{uid}/venues|hosts`, `venueFollowers`, `hostFollowers`). v2
 * keeps ONE edge doc per (follower, target) with a deterministic id, so a
 * follow is idempotent by construction and both directions are a single
 * indexed query. A "host" is an organization.
 *
 * Notifications are written by bus consumers (pub/sub), never inline by the
 * service that caused them. Ids are deterministic per (recipient, source) so
 * an at-least-once redelivery converges to the same doc instead of a
 * duplicate row in the guest's inbox.
 */

export const FOLLOW_TARGET_TYPES = ['venue', 'host'] as const;
export type FollowTargetType = (typeof FOLLOW_TARGET_TYPES)[number];

export interface Follow {
  id: EntityId;
  followerId: EntityId;
  targetType: FollowTargetType;
  targetId: EntityId;
  createdAt: string;
}

export function followId(
  followerId: EntityId,
  targetType: FollowTargetType,
  targetId: EntityId,
): EntityId {
  return `${followerId}__${targetType}__${targetId}`;
}

export function createFollow(input: {
  followerId: EntityId;
  targetType: FollowTargetType;
  targetId: EntityId;
  now: Date;
}): Follow {
  if (!FOLLOW_TARGET_TYPES.includes(input.targetType)) {
    throw new InvalidOperationError(`Unsupported follow target type: ${input.targetType}`);
  }
  return {
    id: followId(input.followerId, input.targetType, input.targetId),
    followerId: input.followerId,
    targetType: input.targetType,
    targetId: input.targetId,
    createdAt: input.now.toISOString(),
  };
}

export const NOTIFICATION_TYPES = ['event.new_from_followed', 'event.material_change'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type EventMaterialChangeResponse = 'accepted' | 'refund_requested';

export function eventMaterialChangeSubjectId(
  eventId: EntityId,
  eventVersion: number,
  orderId: EntityId,
  entitlementId: EntityId | null,
): EntityId {
  const digest = createHash('sha256')
    .update(`${eventId}:${eventVersion}:${orderId}:${entitlementId ?? 'order-contact'}`)
    .digest('hex')
    .slice(0, 32);
  return `EMC-${digest}`;
}

export interface SocialNotification {
  id: EntityId;
  userId: EntityId;
  type: NotificationType;
  title: string;
  body: string;
  /** Relative guest-portal path the notification opens, e.g. `/event/<slug>`. */
  link: string | null;
  /** The aggregate the notification is about (event id for new-event). */
  subjectId: EntityId;
  createdAt: string;
  readAt: string | null;
  /** Present only on ticket-holder notices for a material event change. */
  eventChange?: {
    eventVersion: number;
    entitlementId: EntityId;
    canAccept: boolean;
    canRequestRefund: boolean;
  };
  /** One immutable response per recipient, order, ticket and event version. */
  eventChangeResponse?: {
    response: EventMaterialChangeResponse;
    respondedAt: string;
    respondedBy: EntityId;
  } | null;
}

export type Notification = SocialNotification;

export function notificationId(userId: EntityId, type: NotificationType, subjectId: EntityId) {
  return `${userId}__${type}__${subjectId}`;
}

export function createNotification(input: {
  userId: EntityId;
  type: NotificationType;
  title: string;
  body: string;
  link: string | null;
  subjectId: EntityId;
  eventChange?: {
    eventVersion: number;
    entitlementId: EntityId;
    canAccept: boolean;
    canRequestRefund: boolean;
  };
  now: Date;
}): SocialNotification {
  return {
    id: notificationId(input.userId, input.type, input.subjectId),
    userId: input.userId,
    type: input.type,
    title: input.title,
    body: input.body,
    link: input.link,
    subjectId: input.subjectId,
    createdAt: input.now.toISOString(),
    readAt: null,
    ...(input.eventChange ? { eventChange: input.eventChange } : {}),
    ...(input.eventChange ? { eventChangeResponse: null } : {}),
  };
}
