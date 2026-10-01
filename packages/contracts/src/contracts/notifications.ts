import { z } from 'zod';

import { opaqueIdSchema, pageInfoSchema } from './shared.js';

/**
 * ─── V2 notifications (partner inbox) ─────────────────────────────────────────
 * Mirrors `packages/core`'s `Notification` aggregate and the frontend
 * `@c1rcle/contracts` mirror 1:1. Recipients are ORGANIZATIONS
 * (`recipientId === organizationId`); `recipientType` tells the partner
 * dashboard which workspace surface to render.
 */

export const notificationRecipientTypeSchema = z.enum(['venue', 'host', 'promoter']);
export type NotificationRecipientTypeDto = z.infer<typeof notificationRecipientTypeSchema>;

export const notificationActionTypeSchema = z.enum([
  'promoter_connection',
  'partnership',
  'slot_request',
]);
export type NotificationActionTypeDto = z.infer<typeof notificationActionTypeSchema>;

export const notificationActionSchema = z.object({
  resourceType: notificationActionTypeSchema,
  resourceId: opaqueIdSchema,
});
export type NotificationActionDto = z.infer<typeof notificationActionSchema>;

export const notificationPrioritySchema = z.enum(['normal', 'high']);
export type NotificationPriorityDto = z.infer<typeof notificationPrioritySchema>;

export const notificationDtoSchema = z.object({
  id: opaqueIdSchema,
  recipientId: opaqueIdSchema,
  recipientType: notificationRecipientTypeSchema,
  type: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  read: z.boolean(),
  readAt: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  action: notificationActionSchema.nullable(),
  priority: notificationPrioritySchema,
  createdAt: z.string(),
});
export type NotificationDto = z.infer<typeof notificationDtoSchema>;

export const notificationsListResponseSchema = z.object({
  items: z.array(notificationDtoSchema),
  pageInfo: pageInfoSchema,
  /** Live unread count for the bell badge — returned with every page read. */
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationsListResponse = z.infer<typeof notificationsListResponseSchema>;

/** Body for `PATCH .../notifications/:id/read` (reserved for future payload). */
export const notificationReadRequestSchema = z.object({}).optional();
export type NotificationReadRequest = z.infer<typeof notificationReadRequestSchema>;

export const markAllNotificationsReadResultSchema = z.object({
  selected: z.number().int().nonnegative(),
});
export type MarkAllNotificationsReadResult = z.infer<typeof markAllNotificationsReadResultSchema>;

export const notificationDecisionSchema = z.enum(['approve', 'reject']);
export type NotificationDecisionDto = z.infer<typeof notificationDecisionSchema>;

export const notificationActionRequestSchema = z.object({
  decision: notificationDecisionSchema,
});
export type NotificationActionRequestDto = z.infer<typeof notificationActionRequestSchema>;
