import { z } from 'zod';

import { opaqueIdSchema, paginatedSchema, paginationQuerySchema } from './shared.js';

/**
 * ─── Phase 7: Trust & safety + admin desks Contracts ────────────────────────
 * Support tickets (intake + desk), safety reports, content curation/explore,
 * session/security administration. Each DTO mirrors its domain aggregate
 * field-for-field — the wire contract is the frozen boundary.
 */

// ─── Support tickets ─────────────────────────────────────────────────────────

export const supportTicketStatusSchema = z.enum([
  'open',
  'in_progress',
  'waiting_on_customer',
  'escalated',
  'resolved',
  'closed',
]);
export type SupportTicketStatus = z.infer<typeof supportTicketStatusSchema>;

export const supportTicketPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
export type SupportTicketPriority = z.infer<typeof supportTicketPrioritySchema>;

export const supportTicketCategorySchema = z.enum([
  'account',
  'billing',
  'order',
  'event',
  'technical',
  'other',
]);
export type SupportTicketCategory = z.infer<typeof supportTicketCategorySchema>;

export const supportTicketMessageDtoSchema = z.object({
  id: z.string(),
  senderRole: z.enum(['customer', 'admin']),
  senderId: opaqueIdSchema,
  senderName: z.string(),
  content: z.string(),
  createdAt: z.iso.datetime(),
});
export type SupportTicketMessageDto = z.infer<typeof supportTicketMessageDtoSchema>;

export const supportInternalNoteDtoSchema = z.object({
  id: z.string(),
  authorId: opaqueIdSchema,
  authorName: z.string(),
  content: z.string(),
  createdAt: z.iso.datetime(),
});
export type SupportInternalNoteDto = z.infer<typeof supportInternalNoteDtoSchema>;

export const supportTimelineEventDtoSchema = z.object({
  id: z.string(),
  type: z.enum([
    'created',
    'reply',
    'internal_note',
    'assignment',
    'priority_change',
    'link',
    'escalation',
    'merge',
    'status_change',
    'deleted',
  ]),
  message: z.string(),
  detail: z.string().nullable(),
  actorId: opaqueIdSchema.nullable(),
  at: z.iso.datetime(),
});
export type SupportTimelineEventDto = z.infer<typeof supportTimelineEventDtoSchema>;

export const supportTicketLinksDtoSchema = z.object({
  venueId: opaqueIdSchema.nullable(),
  eventId: opaqueIdSchema.nullable(),
  orderId: opaqueIdSchema.nullable(),
  organizationId: opaqueIdSchema.nullable(),
  userId: opaqueIdSchema.nullable(),
});
export type SupportTicketLinksDto = z.infer<typeof supportTicketLinksDtoSchema>;

export const supportSlaDtoSchema = z.object({
  responseDueAt: z.iso.datetime(),
  resolutionDueAt: z.iso.datetime(),
  responseBreachedAt: z.iso.datetime().nullable(),
  resolutionBreachedAt: z.iso.datetime().nullable(),
});
export type SupportSlaDto = z.infer<typeof supportSlaDtoSchema>;

export const supportTicketRequesterDtoSchema = z.object({
  userId: opaqueIdSchema,
  email: z.email().nullable(),
  organizationId: opaqueIdSchema.nullable(),
});
export type SupportTicketRequesterDto = z.infer<typeof supportTicketRequesterDtoSchema>;

export const supportTicketAssigneeDtoSchema = z.object({
  userId: opaqueIdSchema,
  name: z.string(),
});

export const supportTicketDtoSchema = z.object({
  id: opaqueIdSchema,
  subject: z.string(),
  description: z.string(),
  category: supportTicketCategorySchema,
  status: supportTicketStatusSchema,
  priority: supportTicketPrioritySchema,
  requester: supportTicketRequesterDtoSchema,
  assignee: supportTicketAssigneeDtoSchema.nullable(),
  messages: z.array(supportTicketMessageDtoSchema),
  internalNotes: z.array(supportInternalNoteDtoSchema),
  timeline: z.array(supportTimelineEventDtoSchema),
  links: supportTicketLinksDtoSchema,
  sla: supportSlaDtoSchema,
  mergedInto: opaqueIdSchema.nullable(),
  mergedFrom: z.array(opaqueIdSchema),
  resolvedAt: z.iso.datetime().nullable(),
  resolvedBy: opaqueIdSchema.nullable(),
  closedAt: z.iso.datetime().nullable(),
  closedBy: opaqueIdSchema.nullable(),
  deletedAt: z.iso.datetime().nullable(),
  deletedBy: opaqueIdSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SupportTicketDto = z.infer<typeof supportTicketDtoSchema>;

export const supportTicketListResponseSchema = paginatedSchema(supportTicketDtoSchema);

// ─── Guest intake ────────────────────────────────────────────────────────────

export const submitSupportTicketSchema = z
  .object({
    subject: z.string().min(3).max(200),
    description: z.string().min(10).max(5000),
    category: supportTicketCategorySchema,
    priority: supportTicketPrioritySchema.default('medium'),
    email: z.email().nullish(),
    organizationId: opaqueIdSchema.nullish(),
  })
  .strict();
export type SubmitSupportTicketInput = z.infer<typeof submitSupportTicketSchema>;

export const supportTicketMessageSchema = z
  .object({
    content: z.string().min(1).max(5000),
  })
  .strict();
export type SupportTicketMessageInput = z.infer<typeof supportTicketMessageSchema>;

// ─── Admin desk command bodies ────────────────────────────────────────────────

export const assignSupportTicketSchema = z
  .object({
    userId: opaqueIdSchema,
    name: z.string().min(1).max(200),
  })
  .strict();
export type AssignSupportTicketInput = z.infer<typeof assignSupportTicketSchema>;

export const changeSupportTicketPrioritySchema = z
  .object({
    priority: supportTicketPrioritySchema,
  })
  .strict();
export type ChangeSupportTicketPriorityInput = z.infer<typeof changeSupportTicketPrioritySchema>;

export const supportTicketLinkSchema = z
  .object({
    venueId: opaqueIdSchema.optional(),
    eventId: opaqueIdSchema.optional(),
    orderId: opaqueIdSchema.optional(),
    organizationId: opaqueIdSchema.optional(),
    userId: opaqueIdSchema.optional(),
  })
  .strict();
export type SupportTicketLinkInput = z.infer<typeof supportTicketLinkSchema>;

export const resolveSupportTicketSchema = z.object({
  reason: z.string().min(1).max(1000),
});
export type ResolveSupportTicketInput = z.infer<typeof resolveSupportTicketSchema>;

export const mergeSupportTicketSchema = z
  .object({
    duplicateTicketId: opaqueIdSchema,
  })
  .strict();
export type MergeSupportTicketInput = z.infer<typeof mergeSupportTicketSchema>;

export const supportTicketQuerySchema = paginationQuerySchema.extend({
  status: supportTicketStatusSchema.optional(),
  priority: supportTicketPrioritySchema.optional(),
  category: supportTicketCategorySchema.optional(),
  assigneeUserId: opaqueIdSchema.optional(),
  requesterUserId: opaqueIdSchema.optional(),
  search: z.string().max(200).optional(),
  includeDeleted: z.string().optional(),
});
export type SupportTicketQuery = z.infer<typeof supportTicketQuerySchema>;

export const supportTicketIdParamSchema = z.object({
  ticketId: opaqueIdSchema,
});
export type SupportTicketIdParam = z.infer<typeof supportTicketIdParamSchema>;
