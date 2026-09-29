import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Platform support ticket (Phase 7) ───────────────────────────────────────
 *
 * Ported from v1's `adminStore.js` support block — which is where v1's ticket
 * logic actually lived (the console desk was a ~1,360-LOC presentation layer
 * over these `support_tickets` docs). The v1 rules worth keeping, verbatim:
 *
 *  - assignment, priority change, reply, escalation, close, reopen, and the
 *    merge guardrail set ("cannot merge a ticket into itself", "primary is
 *    already merged", "duplicate is already merged");
 *  - the message + timeline + internal-note aggregate stored inside the ticket
 *    doc — one versioned aggregate, no separate collections;
 *  - `resolvedAt`/`resolvedBy` and `updatedAt` stamps preserved by every
 *    transition.
 *
 * What v1's desk masked with hardcoded fake "SLA agents" (the roadmap calls
 * the desk's SLA region fake) is real here: every priority carries a response
 * and a resolution deadline, and `refreshSla` flips the breach flags the
 * moment either one passes while the ticket is still live. Soft-delete carries
 * attribution (`deletedBy`/`deletedAt`), never a hard delete — the same
 * rule `event.ts` uses.
 *
 * This is the *aggregate*; the two services that drive it (`SupportService`
 * for the guest/requester side, `AdminSupportService` for the desk) live in
 * `application/support/`. Every desk mutation is TIER1 in access terms —
 * `admin-support-service` uses `requireAdmin` (any platform admin may act,
 * merely logged), so no new `AdminAction` entry was needed in
 * `admin-authority.ts`.
 */

export type SupportTicketStatus =
  'open' | 'in_progress' | 'waiting_on_customer' | 'escalated' | 'resolved' | 'closed';

export type SupportTicketPriority = 'low' | 'medium' | 'high' | 'urgent';

export type SupportTicketCategory =
  'account' | 'billing' | 'order' | 'event' | 'technical' | 'other';

export interface SupportTicketRequester {
  userId: EntityId;
  /** Set on the guest intake path; null when an admin opens a ticket directly. */
  email: string | null;
  organizationId: EntityId | null;
}

export interface SupportTicketMessage {
  id: string;
  senderRole: 'customer' | 'admin';
  senderId: EntityId;
  senderName: string;
  content: string;
  createdAt: string;
}

export interface SupportInternalNote {
  id: string;
  authorId: EntityId;
  authorName: string;
  content: string;
  createdAt: string;
}

export type SupportTimelineEventType =
  | 'created'
  | 'reply'
  | 'internal_note'
  | 'assignment'
  | 'priority_change'
  | 'link'
  | 'escalation'
  | 'merge'
  | 'status_change'
  | 'deleted';

export interface SupportTimelineEvent {
  id: string;
  type: SupportTimelineEventType;
  message: string;
  detail: string | null;
  actorId: EntityId | null;
  at: string;
}

/**
 * What a ticket can be attached to. Mirrors v1's `linkSupportTicket` entity
 * list (venue / host→organization / promoter / event / subscription→order),
 * re-expressed against v2's real concepts.
 */
export interface SupportTicketLinks {
  venueId: EntityId | null;
  eventId: EntityId | null;
  orderId: EntityId | null;
  organizationId: EntityId | null;
  userId: EntityId | null;
}

export interface SupportSla {
  responseDueAt: string;
  resolutionDueAt: string;
  responseBreachedAt: string | null;
  resolutionBreachedAt: string | null;
}

export interface SupportTicket extends VersionedEntity {
  id: EntityId;
  subject: string;
  description: string;
  category: SupportTicketCategory;
  status: SupportTicketStatus;
  priority: SupportTicketPriority;
  requester: SupportTicketRequester;
  assignee: { userId: EntityId; name: string } | null;
  messages: SupportTicketMessage[];
  internalNotes: SupportInternalNote[];
  timeline: SupportTimelineEvent[];
  links: SupportTicketLinks;
  sla: SupportSla;
  mergedInto: EntityId | null;
  /** Clients the primary absorbed — the mirror of `mergedInto` (v2 addition). */
  mergedFrom: EntityId[];
  resolvedAt: string | null;
  resolvedBy: EntityId | null;
  closedAt: string | null;
  closedBy: EntityId | null;
  /** Soft-delete attribution — never a hard delete (see `event.ts`). */
  deletedAt: string | null;
  deletedBy: EntityId | null;
}

export interface CreateSupportTicketInput {
  id: EntityId;
  subject: string;
  description: string;
  category: SupportTicketCategory;
  priority: SupportTicketPriority;
  requester: SupportTicketRequester;
  now?: Date;
}

/** Response/resolution SLA targets per priority, in hours. */
export const SLA_RESPONSE_HOURS: Record<SupportTicketPriority, number> = {
  urgent: 1,
  high: 4,
  medium: 24,
  low: 72,
};

export const SLA_RESOLUTION_HOURS: Record<SupportTicketPriority, number> = {
  urgent: 4,
  high: 24,
  medium: 72,
  low: 168,
};

function hoursFrom(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 60 * 60 * 1000).toISOString();
}

function nextSubId(prefix: string, count: number): string {
  return `${prefix}_${count + 1}`;
}

function timelineEvent(
  ticket: SupportTicket,
  type: SupportTimelineEventType,
  message: string,
  detail: string | null,
  actorId: EntityId | null,
  at: Date,
): SupportTimelineEvent {
  return {
    id: nextSubId('ev', ticket.timeline.length),
    type,
    message,
    detail,
    actorId,
    at: at.toISOString(),
  };
}

const TERMINAL_STATUSES: readonly SupportTicketStatus[] = ['resolved', 'closed'];

function isTerminal(ticket: SupportTicket): boolean {
  return TERMINAL_STATUSES.includes(ticket.status);
}

/**
 * Recomputes the two breach flags from the current deadline and message state.
 * Response breach applies while the customer is waiting on the admin (the
 * newest thread message is from the customer, or there are no messages yet);
 * resolution breach applies while the ticket is not resolved/closed.
 */
export function refreshSla(
  ticket: Pick<SupportTicket, 'sla' | 'status' | 'messages'>,
  now: Date,
): SupportSla {
  const last = ticket.messages[ticket.messages.length - 1];
  const responseViolated =
    (last ? last.senderRole === 'customer' : true) &&
    now.getTime() > new Date(ticket.sla.responseDueAt).getTime();
  return {
    ...ticket.sla,
    responseBreachedAt: responseViolated
      ? (ticket.sla.responseBreachedAt ?? now.toISOString())
      : null,
    resolutionBreachedAt:
      !isTerminal(ticket as SupportTicket) &&
      now.getTime() > new Date(ticket.sla.resolutionDueAt).getTime()
        ? (ticket.sla.resolutionBreachedAt ?? now.toISOString())
        : null,
  };
}

/** Fresh SLA window for a ticket born (or re-prioritised / re-opened) at `at`. */
export function slaFor(priority: SupportTicketPriority, at: Date): SupportSla {
  const started = at.toISOString();
  return {
    responseDueAt: hoursFrom(started, SLA_RESPONSE_HOURS[priority]),
    resolutionDueAt: hoursFrom(started, SLA_RESOLUTION_HOURS[priority]),
    responseBreachedAt: null,
    resolutionBreachedAt: null,
  };
}

export function createSupportTicket(input: CreateSupportTicketInput): SupportTicket {
  if (input.subject.trim().length === 0) {
    throw new InvalidOperationError('A support ticket requires a subject');
  }
  if (input.description.trim().length === 0) {
    throw new InvalidOperationError('A support ticket requires a description');
  }
  const now = input.now ?? new Date();
  const base = newVersionedEntity(now);
  const ticket: SupportTicket = {
    id: input.id,
    subject: input.subject.trim(),
    description: input.description.trim(),
    category: input.category,
    status: 'open',
    priority: input.priority,
    requester: input.requester,
    assignee: null,
    messages: [],
    internalNotes: [],
    timeline: [],
    links: {
      venueId: null,
      eventId: null,
      orderId: null,
      organizationId: null,
      userId: input.requester.organizationId ? null : input.requester.userId,
    },
    sla: slaFor(input.priority, now),
    mergedInto: null,
    mergedFrom: [],
    resolvedAt: null,
    resolvedBy: null,
    closedAt: null,
    closedBy: null,
    deletedAt: null,
    deletedBy: null,
    ...base,
  };
  ticket.timeline.push(
    timelineEvent(
      ticket,
      'created',
      'Ticket Created',
      `Category: ${input.category}, priority: ${input.priority}`,
      input.requester.userId,
      now,
    ),
  );
  return { ...ticket, sla: refreshSla(ticket, now) };
}

export function addCustomerMessage(
  ticket: SupportTicket,
  content: string,
  now: Date = new Date(),
): SupportTicket {
  if (content.trim().length === 0) throw new InvalidOperationError('A message cannot be empty');
  if (isTerminal(ticket) || ticket.deletedAt)
    throw new InvalidOperationError(`This ticket is ${ticket.status} — messages are closed`);
  const at = now.toISOString();
  const message: SupportTicketMessage = {
    id: nextSubId('msg', ticket.messages.length),
    senderRole: 'customer',
    senderId: ticket.requester.userId,
    senderName: ticket.requester.email ?? ticket.requester.userId,
    content: content.trim(),
    createdAt: at,
  };
  const messages = [...ticket.messages, message];
  // A customer follow-up moves a `waiting_on_customer` ticket back into work.
  const status = ticket.status === 'waiting_on_customer' ? 'in_progress' : ticket.status;
  const next: SupportTicket = {
    ...bumpVersion(ticket, now),
    messages,
    status,
    sla: { ...ticket.sla, responseDueAt: hoursFrom(at, SLA_RESPONSE_HOURS[ticket.priority]) },
    timeline: [
      ...ticket.timeline,
      timelineEvent(ticket, 'reply', 'Customer Replied', null, message.senderId, now),
    ],
  };
  return { ...next, sla: refreshSla(next, now) };
}

export function addAdminReply(
  ticket: SupportTicket,
  admin: { userId: EntityId; name: string },
  content: string,
  now: Date = new Date(),
): SupportTicket {
  if (content.trim().length === 0) throw new InvalidOperationError('A reply cannot be empty');
  if (isTerminal(ticket) || ticket.deletedAt)
    throw new InvalidOperationError(`This ticket is ${ticket.status} — replies are closed`);
  const at = now.toISOString();
  const message: SupportTicketMessage = {
    id: nextSubId('msg', ticket.messages.length),
    senderRole: 'admin',
    senderId: admin.userId,
    senderName: admin.name,
    content: content.trim(),
    createdAt: at,
  };
  const messages = [...ticket.messages, message];
  const next: SupportTicket = {
    ...bumpVersion(ticket, now),
    messages,
    status: 'waiting_on_customer',
    sla: { ...ticket.sla, responseDueAt: hoursFrom(at, SLA_RESPONSE_HOURS[ticket.priority]) },
    timeline: [
      ...ticket.timeline,
      timelineEvent(ticket, 'reply', 'Admin Replied', null, admin.userId, now),
    ],
  };
  return { ...next, sla: refreshSla(next, now) };
}

export function addInternalNote(
  ticket: SupportTicket,
  admin: { userId: EntityId; name: string },
  content: string,
  now: Date = new Date(),
): SupportTicket {
  if (content.trim().length === 0) throw new InvalidOperationError('A note cannot be empty');
  if (ticket.deletedAt) throw new InvalidOperationError('This ticket is deleted');
  const note: SupportInternalNote = {
    id: nextSubId('note', ticket.internalNotes.length),
    authorId: admin.userId,
    authorName: admin.name,
    content: content.trim(),
    createdAt: now.toISOString(),
  };
  const next: SupportTicket = {
    ...bumpVersion(ticket, now),
    internalNotes: [...ticket.internalNotes, note],
    timeline: [
      ...ticket.timeline,
      timelineEvent(ticket, 'internal_note', 'Internal Note Added', null, admin.userId, now),
    ],
  };
  return { ...next, sla: refreshSla(next, now) };
}

export function assignTicket(
  ticket: SupportTicket,
  assignee: { userId: EntityId; name: string },
  now: Date = new Date(),
): SupportTicket {
  if (isTerminal(ticket) || ticket.deletedAt)
    throw new InvalidOperationError(`Cannot assign a ${ticket.status} ticket`);
  const status = ticket.status === 'open' ? 'in_progress' : ticket.status;
  const next: SupportTicket = {
    ...bumpVersion(ticket, now),
    assignee,
    status,
    timeline: [
      ...ticket.timeline,
      timelineEvent(
        ticket,
        'assignment',
        `Ticket Assigned to ${assignee.name}`,
        `Assigned agent ID: ${assignee.userId}`,
        assignee.userId,
        now,
      ),
    ],
  };
  return { ...next, sla: refreshSla(next, now) };
}

export function changeTicketPriority(
  ticket: SupportTicket,
  priority: SupportTicketPriority,
  now: Date = new Date(),
): SupportTicket {
  if (isTerminal(ticket) || ticket.deletedAt)
    throw new InvalidOperationError(`Cannot reprioritise a ${ticket.status} ticket`);
  const at = now;
  const next: SupportTicket = {
    ...bumpVersion(ticket, now),
    priority,
    // A jump in urgency re-arms both deadlines from now (v1 only recorded the
    // change; recomputing is the real-SLA improvement).
    sla: slaFor(priority, at),
    timeline: [
      ...ticket.timeline,
      timelineEvent(
        ticket,
        'priority_change',
        `Priority Changed to ${priority}`,
        `Priority changed from ${ticket.priority} to ${priority}`,
        null,
        now,
      ),
    ],
  };
  return { ...next, sla: refreshSla(next, now) };
}

export function linkTicket(
  ticket: SupportTicket,
  links: Partial<SupportTicketLinks>,
  adminId: EntityId | null,
  now: Date = new Date(),
): SupportTicket {
  if (ticket.deletedAt) throw new InvalidOperationError('This ticket is deleted');
  const entity = (Object.keys(links) as (keyof SupportTicketLinks)[]).find(
    (key) => links[key] !== undefined,
  );
  if (!entity || links[entity] === null)
    throw new InvalidOperationError('Link changes must carry at least one entity');
  const next: SupportTicket = {
    ...bumpVersion(ticket, now),
    links: { ...ticket.links, ...links },
    timeline: [
      ...ticket.timeline,
      timelineEvent(
        ticket,
        'link',
        `Ticket Linked to ${entity}`,
        `Linked ${entity}: ${String(links[entity])}`,
        adminId,
        now,
      ),
    ],
  };
  return { ...next, sla: refreshSla(next, now) };
}

export function escalateTicket(
  ticket: SupportTicket,
  adminId: EntityId,
  now: Date = new Date(),
): SupportTicket {
  if (isTerminal(ticket) || ticket.deletedAt)
    throw new InvalidOperationError(`Cannot escalate a ${ticket.status} ticket`);
  const next: SupportTicket = {
    ...bumpVersion(ticket, now),
    status: 'escalated',
    timeline: [
      ...ticket.timeline,
      timelineEvent(
        ticket,
        'escalation',
        'Ticket Escalated to Technical Team',
        'Status changed to escalated',
        adminId,
        now,
      ),
    ],
  };
  return { ...next, sla: refreshSla(next, now) };
}

export function resolveTicket(
  ticket: SupportTicket,
  adminId: EntityId,
  reason: string,
  now: Date = new Date(),
): SupportTicket {
  if (isTerminal(ticket) || ticket.deletedAt)
    throw new InvalidOperationError(`Cannot resolve a ${ticket.status} ticket`);
  if (reason.trim().length === 0) throw new InvalidOperationError('Resolving requires a reason');
  const at = now.toISOString();
  const next: SupportTicket = {
    ...bumpVersion(ticket, now),
    status: 'resolved',
    resolvedAt: at,
    resolvedBy: adminId,
    timeline: [
      ...ticket.timeline,
      timelineEvent(ticket, 'status_change', 'Ticket Resolved', reason.trim(), adminId, now),
    ],
  };
  return { ...next, sla: refreshSla(next, now) };
}

export function closeTicket(
  ticket: SupportTicket,
  adminId: EntityId,
  now: Date = new Date(),
): SupportTicket {
  if (ticket.deletedAt) throw new InvalidOperationError('This ticket is deleted');
  if (ticket.status === 'closed') throw new InvalidOperationError('This ticket is already closed');
  const at = now.toISOString();
  const next: SupportTicket = {
    ...bumpVersion(ticket, now),
    status: 'closed',
    closedAt: at,
    closedBy: adminId,
    timeline: [
      ...ticket.timeline,
      timelineEvent(
        ticket,
        'status_change',
        'Ticket Closed',
        'Status changed to closed',
        adminId,
        now,
      ),
    ],
  };
  return { ...next, sla: refreshSla(next, now) };
}

export function reopenTicket(
  ticket: SupportTicket,
  adminId: EntityId,
  now: Date = new Date(),
): SupportTicket {
  if (!isTerminal(ticket))
    throw new InvalidOperationError(`Only resolved or closed tickets can be reopened`);
  if (ticket.deletedAt) throw new InvalidOperationError('This ticket is deleted');
  if (ticket.mergedInto)
    throw new InvalidOperationError(
      'A merged ticket cannot be reopened on its own — reopen its primary',
    );
  const next: SupportTicket = {
    ...bumpVersion(ticket, now),
    status: 'open',
    resolvedAt: null,
    resolvedBy: null,
    closedAt: null,
    closedBy: null,
    // A reopened ticket gets a fresh resolution target (and its old breach
    // flags are recomputed away) — v1 reopened to `open` with no SLA at all.
    sla: slaFor(ticket.priority, now),
    timeline: [
      ...ticket.timeline,
      timelineEvent(
        ticket,
        'status_change',
        'Ticket Reopened by Admin',
        'Status changed to open',
        adminId,
        now,
      ),
    ],
  };
  return { ...next, sla: refreshSla(next, now) };
}

/**
 * Merges a duplicate into a primary, v1 semantics:
 *  - neither may be merged already, neither partially/fully the same ticket;
 *  - the duplicate's messages are absorbed into the primary thread, annotated
 *    with their origin ticket and kept in chronological order;
 *  - the duplicate is closed with `mergedInto` set — it is never deleted.
 */
export function mergeDuplicateTicket(
  primary: SupportTicket,
  duplicate: SupportTicket,
  adminId: EntityId,
  now: Date = new Date(),
): { primary: SupportTicket; duplicate: SupportTicket } {
  if (primary.id === duplicate.id)
    throw new InvalidOperationError('Cannot merge a ticket into itself');
  if (primary.deletedAt) throw new InvalidOperationError('The primary ticket is deleted');
  if (duplicate.deletedAt) throw new InvalidOperationError('The duplicate ticket is deleted');
  if (primary.mergedInto)
    throw new InvalidOperationError(
      `Cannot merge: the primary is already merged into ${primary.mergedInto}`,
    );
  if (duplicate.mergedInto)
    throw new InvalidOperationError(
      `Ticket ${duplicate.id.slice(-8).toUpperCase()} is already merged into ${duplicate.mergedInto.slice(-8).toUpperCase()}`,
    );
  if (primary.mergedFrom.includes(duplicate.id) || duplicate.mergedFrom.includes(primary.id))
    throw new InvalidOperationError('These tickets are already merged');

  const suffix = duplicate.id.slice(-8).toUpperCase();
  const annotated = duplicate.messages.map((message) => ({
    ...message,
    content: `[Merged from ticket ${suffix}] ${message.content}`,
  }));
  const messages = [...primary.messages, ...annotated].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  const mergedPrimary: SupportTicket = {
    ...bumpVersion(primary, now),
    messages,
    mergedFrom: [...primary.mergedFrom, duplicate.id],
    timeline: [
      ...primary.timeline,
      timelineEvent(
        primary,
        'merge',
        'Merged Duplicate Ticket',
        `Merged duplicate ticket ID: ${duplicate.id}`,
        adminId,
        now,
      ),
    ],
  };

  const closedDuplicate: SupportTicket = {
    ...bumpVersion(duplicate, now),
    status: 'closed',
    closedAt: now.toISOString(),
    closedBy: adminId,
    mergedInto: primary.id,
    timeline: [
      ...duplicate.timeline,
      timelineEvent(
        duplicate,
        'merge',
        'Ticket Merged and Closed',
        `Merged into primary ticket ID: ${primary.id}`,
        adminId,
        now,
      ),
    ],
  };
  return {
    primary: { ...mergedPrimary, sla: refreshSla(mergedPrimary, now) },
    duplicate: { ...closedDuplicate, sla: refreshSla(closedDuplicate, now) },
  };
}

/** Soft delete with attribution — the record and its timeline stay intact. */
export function deleteTicket(
  ticket: SupportTicket,
  deletedBy: EntityId,
  now: Date = new Date(),
): SupportTicket {
  if (ticket.deletedAt) throw new InvalidOperationError('This ticket is already deleted');
  const next: SupportTicket = {
    ...bumpVersion(ticket, now),
    deletedAt: now.toISOString(),
    deletedBy,
    timeline: [
      ...ticket.timeline,
      timelineEvent(ticket, 'deleted', 'Ticket Deleted', null, deletedBy, now),
    ],
  };
  return { ...next, sla: refreshSla(next, now) };
}

/** Restoration of a soft-deleted ticket (attribution preserved, flags cleared). */
export function restoreTicket(
  ticket: SupportTicket,
  adminId: EntityId,
  now: Date = new Date(),
): SupportTicket {
  if (!ticket.deletedAt) throw new InvalidOperationError('This ticket is not deleted');
  const next: SupportTicket = {
    ...bumpVersion(ticket, now),
    deletedAt: null,
    deletedBy: null,
    timeline: [
      ...ticket.timeline,
      timelineEvent(ticket, 'status_change', 'Ticket Restored', null, adminId, now),
    ],
  };
  return { ...next, sla: refreshSla(next, now) };
}
