import { z } from 'zod';

import { cursorSchema, opaqueIdSchema, pageInfoSchema } from './shared.js';

/**
 * ─── Phase 8: follow graph + in-app notifications ───────────────────────────
 * Session-scoped guest surface (no `X-Organization-Id`). A "host" target is an
 * organization id. Follow/unfollow are idempotent by construction (one edge
 * doc per follower+target), so they need no `Idempotency-Key`.
 *
 * List responses add `nextCursor` beside the shared `pageInfo` — the shared
 * shape has no cursor field, and an inbox must be pageable.
 */

export const followTargetTypeSchema = z.enum(['venue', 'host']);
export type FollowTargetTypeDto = z.infer<typeof followTargetTypeSchema>;

/** `POST /api/v2/follows` */
export const createFollowSchema = z
  .object({ targetType: followTargetTypeSchema, targetId: opaqueIdSchema })
  .strict();
export type CreateFollowRequest = z.infer<typeof createFollowSchema>;

/** `DELETE /api/v2/follows/:targetType/:targetId`, `GET .../status` */
export const followTargetParamsSchema = z.object({
  targetType: followTargetTypeSchema,
  targetId: opaqueIdSchema,
});

export const followDtoSchema = z.object({
  id: z.string().min(1).max(256),
  targetType: followTargetTypeSchema,
  targetId: z.string().min(1).max(128),
  createdAt: z.iso.datetime(),
});
export type FollowDto = z.infer<typeof followDtoSchema>;

/** `GET /api/v2/follows/me` */
export const listMyFollowsQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  targetType: followTargetTypeSchema.optional(),
});
export const followListResponseSchema = z.object({
  items: z.array(followDtoSchema),
  pageInfo: pageInfoSchema,
  nextCursor: cursorSchema.nullable(),
});
export type FollowListResponse = z.infer<typeof followListResponseSchema>;

/** `GET /api/v2/follows/:targetType/:targetId/status` */
export const followStatusDtoSchema = z.object({
  following: z.boolean(),
  followerCount: z.number().int().nonnegative(),
});
export type FollowStatusDto = z.infer<typeof followStatusDtoSchema>;

export const notificationTypeSchema = z.enum(['event.new_from_followed']);

export const notificationDtoSchema = z.object({
  id: z.string().min(1).max(256),
  type: notificationTypeSchema,
  title: z.string().min(1).max(300),
  body: z.string().max(1000),
  link: z.string().max(500).nullable(),
  subjectId: z.string().min(1).max(128),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});
export type NotificationDto = z.infer<typeof notificationDtoSchema>;

/** `GET /api/v2/notifications/me` */
export const listNotificationsQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export const notificationListResponseSchema = z.object({
  items: z.array(notificationDtoSchema),
  pageInfo: pageInfoSchema,
  nextCursor: cursorSchema.nullable(),
});
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

/** `GET /api/v2/notifications/me/unread-count` */
export const unreadCountDtoSchema = z.object({ count: z.number().int().nonnegative() });
export type UnreadCountDto = z.infer<typeof unreadCountDtoSchema>;

/** `POST /api/v2/notifications/me/read` — ids not owned by the caller are skipped. */
export const markNotificationsReadSchema = z
  .object({ ids: z.array(z.string().min(1).max(256)).min(1).max(100) })
  .strict();
export type MarkNotificationsReadRequest = z.infer<typeof markNotificationsReadSchema>;

/** Response for both mark-read commands. */
export const markReadResultDtoSchema = z.object({ updated: z.number().int().nonnegative() });
export type MarkReadResultDto = z.infer<typeof markReadResultDtoSchema>;
