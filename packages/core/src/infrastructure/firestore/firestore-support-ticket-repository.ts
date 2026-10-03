import { VersionConflictError } from '../../domain/errors.js';

import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { SupportTicket } from '../../domain/models/support-ticket.js';
import type {
  Page,
  PaginationQuery,
  SupportTicketQuery,
  SupportTicketRepository,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore, Query } from 'firebase-admin/firestore';

const SUPPORT_TICKET_COLLECTION = 'v2_support_tickets';

function matchesFilter(ticket: SupportTicket, query: SupportTicketQuery): boolean {
  const primary: (keyof SupportTicketQuery)[] = ['status', 'priority', 'category'];
  const applied = primary.map((key) => query[key]);
  const remaining = Object.fromEntries(
    Object.entries(query).filter(
      ([key, value]) => !primary.includes(key as keyof SupportTicketQuery) && value !== undefined,
    ),
  ) as Partial<SupportTicketQuery>;
  if (
    remaining.assigneeUserId !== undefined &&
    ticket.assignee?.userId !== remaining.assigneeUserId
  )
    return false;
  if (
    remaining.requesterUserId !== undefined &&
    ticket.requester.userId !== remaining.requesterUserId
  )
    return false;
  if (!remaining.includeDeleted && ticket.deletedAt) return false;
  if (remaining.search) {
    const haystack = `${ticket.subject} ${ticket.description}`.toLowerCase();
    if (!haystack.includes(remaining.search.toLowerCase())) return false;
  }
  return applied.every((value) => value === undefined);
}

export class FirestoreSupportTicketRepository implements SupportTicketRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(SUPPORT_TICKET_COLLECTION);
  }

  async getById(id: EntityId, opts?: { includeDeleted?: boolean }): Promise<SupportTicket | null> {
    const snap = await this.collection.doc(id).get();
    const data = snap.data();
    if (!data) return null;
    const ticket = toSupportTicket(data);
    if (ticket.deletedAt && !opts?.includeDeleted) return null;
    return ticket;
  }

  async listByMergedInto(ticketId: EntityId): Promise<SupportTicket[]> {
    const snap = await this.collection
      .where('mergedInto', '==', ticketId)
      .where('deletedAt', '==', null)
      .get();
    return snap.docs.map((doc) => toSupportTicket(doc.data()));
  }

  async list(query: SupportTicketQuery, pagination: PaginationQuery): Promise<Page<SupportTicket>> {
    // Build a storage-level query off at most ONE equality filter to avoid
    // composite-index sprawl (existing contract elsewhere in this repo: a
    // bare field+`orderBy` composite is the accepted cost). Every remaining
    // filter (assignee, requester, search, soft-delete visibility) is applied
    // over the mapped page in `matchesFilter` — behavior stays identical to
    // the memory adapter, and no new indexes are introduced.
    let base: Query = this.collection;
    if (query.status) base = base.where('status', '==', query.status);
    else if (query.priority) base = base.where('priority', '==', query.priority);
    else if (query.category) base = base.where('category', '==', query.category);
    base = base.orderBy('createdAt', 'desc');

    const page = await paginateQuery(base, pagination, toSupportTicket);
    const items = page.items.filter((ticket) => matchesFilter(ticket, query));
    return { items, total: page.total, nextCursor: page.nextCursor };
  }

  async listByRequester(
    requesterUserId: EntityId,
    pagination: PaginationQuery,
  ): Promise<Page<SupportTicket>> {
    const base = this.collection
      .where('requesterUserId', '==', requesterUserId)
      .where('deletedAt', '==', null)
      .orderBy('createdAt', 'desc');
    const page = await paginateQuery(base, pagination, toSupportTicket);
    const items = page.items.filter((ticket) => ticket.deletedAt === null);
    return { items, total: page.total, nextCursor: page.nextCursor };
  }

  async save(ticket: SupportTicket): Promise<void> {
    const ref = this.collection.doc(ticket.id);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (data) {
        const existing = toSupportTicket(data);
        if (existing.version !== ticket.version - 1) {
          throw new VersionConflictError(ticket.version - 1, existing.version);
        }
      }
      tx.set(ref, toDoc(ticket));
    });
  }
}

/** Denormalised `requester.userId` for the requester query without an index. */
function toDoc(ticket: SupportTicket): DocumentData {
  return {
    id: ticket.id,
    subject: ticket.subject,
    description: ticket.description,
    category: ticket.category,
    status: ticket.status,
    priority: ticket.priority,
    requesterUserId: ticket.requester.userId,
    requester: ticket.requester,
    assignee: ticket.assignee,
    messages: ticket.messages,
    internalNotes: ticket.internalNotes,
    timeline: ticket.timeline,
    links: ticket.links,
    sla: ticket.sla,
    mergedInto: ticket.mergedInto,
    mergedFrom: ticket.mergedFrom,
    resolvedAt: ticket.resolvedAt,
    resolvedBy: ticket.resolvedBy,
    closedAt: ticket.closedAt,
    closedBy: ticket.closedBy,
    deletedAt: ticket.deletedAt,
    deletedBy: ticket.deletedBy,
    version: ticket.version,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

function toSupportTicket(data: DocumentData): SupportTicket {
  return {
    id: data.id as string,
    subject: data.subject as string,
    description: data.description as string,
    category: data.category as SupportTicket['category'],
    status: data.status as SupportTicket['status'],
    priority: data.priority as SupportTicket['priority'],
    requester: data.requester as SupportTicket['requester'],
    assignee: data.assignee as SupportTicket['assignee'],
    messages: data.messages as SupportTicket['messages'],
    internalNotes: data.internalNotes as SupportTicket['internalNotes'],
    timeline: data.timeline as SupportTicket['timeline'],
    links: data.links as SupportTicket['links'],
    sla: data.sla as SupportTicket['sla'],
    mergedInto: data.mergedInto as string | null,
    mergedFrom: data.mergedFrom as string[],
    resolvedAt: data.resolvedAt as string | null,
    resolvedBy: data.resolvedBy as string | null,
    closedAt: data.closedAt as string | null,
    closedBy: data.closedBy as string | null,
    deletedAt: data.deletedAt as string | null,
    deletedBy: data.deletedBy as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
