import { VersionConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { SupportTicket } from '../../domain/models/support-ticket.js';
import type {
  Page,
  PaginationQuery,
  SupportTicketQuery,
  SupportTicketRepository,
} from '../../domain/ports/repositories.js';

function matches(ticket: SupportTicket, query: SupportTicketQuery): boolean {
  if (query.status !== undefined && ticket.status !== query.status) return false;
  if (query.priority !== undefined && ticket.priority !== query.priority) return false;
  if (query.category !== undefined && ticket.category !== query.category) return false;
  if (query.assigneeUserId !== undefined && ticket.assignee?.userId !== query.assigneeUserId)
    return false;
  if (query.requesterUserId !== undefined && ticket.requester.userId !== query.requesterUserId)
    return false;
  if (!query.includeDeleted && ticket.deletedAt) return false;
  if (query.search) {
    const haystack = `${ticket.subject} ${ticket.description}`.toLowerCase();
    if (!haystack.includes(query.search.toLowerCase())) return false;
  }
  return true;
}

function serializeSlice<T extends { id: EntityId }>(all: T[], query: PaginationQuery): Page<T> {
  const { cursor, limit } = query;
  const start = cursor ? all.findIndex((item) => item.id === cursor) + 1 : 0;
  const end = Math.min(start + limit, all.length);
  const items = all.slice(start, end);
  const last = items[items.length - 1];
  const nextCursor = end < all.length && last ? last.id : null;
  return { items, total: all.length, nextCursor };
}

export class MemorySupportTicketRepository implements SupportTicketRepository {
  tickets = new Map<EntityId, SupportTicket>();

  async getById(id: EntityId, opts?: { includeDeleted?: boolean }): Promise<SupportTicket | null> {
    const ticket = this.tickets.get(id) ?? null;
    if (ticket && ticket.deletedAt && !opts?.includeDeleted) return null;
    return ticket;
  }

  async listByMergedInto(ticketId: EntityId): Promise<SupportTicket[]> {
    return [...this.tickets.values()].filter((t) => t.mergedInto === ticketId);
  }

  async list(query: SupportTicketQuery, pagination: PaginationQuery): Promise<Page<SupportTicket>> {
    const all = [...this.tickets.values()]
      .filter((t) => matches(t, query))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return serializeSlice(all, pagination);
  }

  async listByRequester(
    requesterUserId: EntityId,
    pagination: PaginationQuery,
  ): Promise<Page<SupportTicket>> {
    const all = [...this.tickets.values()]
      .filter((t) => t.requester.userId === requesterUserId && !t.deletedAt)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return serializeSlice(all, pagination);
  }

  async save(ticket: SupportTicket): Promise<void> {
    const existing = this.tickets.get(ticket.id);
    if (existing && existing.version !== ticket.version - 1) {
      throw new VersionConflictError(ticket.version - 1, existing.version);
    }
    this.tickets.set(ticket.id, ticket);
  }
}
