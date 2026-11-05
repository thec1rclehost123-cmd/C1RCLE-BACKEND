import { InvalidOperationError, NotFoundError, UnauthorizedError } from '../../domain/errors.js';
import {
  refundReviewEligibility,
  refundReviewTicketId,
} from '../../domain/models/refund-review.js';
import { addCustomerMessage, createSupportTicket } from '../../domain/models/support-ticket.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  SupportTicket,
  SupportTicketCategory,
  SupportTicketPriority,
} from '../../domain/models/support-ticket.js';
import type { PaginationQuery } from '../../domain/ports/repositories.js';
import type { ServiceDeps } from '../context.js';

/**
 * ─── Guest/requester support service (Phase 7) ───────────────────────────────
 * The intake side of the support desk v1 never got: a signed-in guest (or a
 * requester on an existing ticket) opens tickets and follows up on them.
 * No admin authority is required here — `requireUserId` at the route is the
 * only gate, and every method scopes to the requester's own userId (a
 * follow-up on someone else's ticket is a 404, not a security hint).
 *
 * Everything the admin desk does lives in `AdminSupportService`; both drive
 * the same `support-ticket.ts` aggregate.
 */

export interface SubmitTicketCommand {
  subject: string;
  description: string;
  category: SupportTicketCategory;
  priority: SupportTicketPriority;
  /** Present on the guest intake path (self-served); null when undisclosed. */
  email: string | null;
  organizationId: EntityId | null;
}

export class SupportService {
  constructor(private deps: ServiceDeps) {}

  private get tickets() {
    return this.deps.repositories.supportTickets;
  }

  async requestTicketRefundReview(
    userId: EntityId,
    ticketId: EntityId,
    reason: string,
  ): Promise<SupportTicket> {
    if (!userId) throw new UnauthorizedError('Sign in to request a refund');
    const user = await this.deps.repositories.users.getById(userId);
    if (!user?.emailVerified) throw new UnauthorizedError('A verified account is required');
    const ticket = await this.deps.repositories.entitlements.getById(ticketId);
    const order = ticket ? await this.deps.repositories.orders.getById(ticket.orderId) : null;
    const event = ticket ? await this.deps.repositories.events.getById(ticket.eventId) : null;
    if (!ticket || !order || !event || order.userId !== userId)
      throw new NotFoundError('Ticket', ticketId);
    const id = refundReviewTicketId(userId, ticketId);
    const existing = await this.tickets.getById(id);
    if (existing) return existing;
    const now = this.deps.config.clock.now();
    const eligibility = refundReviewEligibility(event, order, ticket, userId, now);
    if (!eligibility.allowed)
      throw new InvalidOperationError(
        eligibility.reason ?? 'This ticket is unavailable for refund review',
      );
    if (!reason.trim() || reason.trim().length > 2000)
      throw new InvalidOperationError('Explain your refund request in up to 2000 characters');
    const created = createSupportTicket({
      id,
      subject: `Refund request: ${event.title}`,
      description: reason.trim(),
      category: 'billing',
      priority: 'medium',
      requester: { userId, email: null, organizationId: null },
      now,
    });
    const review: SupportTicket = {
      ...created,
      links: {
        ...created.links,
        orderId: order.id,
        eventId: event.id,
        organizationId: order.organizationId,
        userId,
      },
      refundReview: {
        orderId: order.id,
        entitlementIds: [ticket.id],
        eventVersion: event.version,
        policyKind: event.refundPolicy?.kind ?? 'organizer_reviewed',
        requestedAt: now.toISOString(),
      },
    };
    if (!(await this.tickets.createIfAbsent(review))) {
      const winner = await this.tickets.getById(id);
      if (!winner) throw new NotFoundError('Refund review', id);
      return winner;
    }
    return review;
  }

  async submitTicket(
    requesterUserId: EntityId,
    command: SubmitTicketCommand,
  ): Promise<SupportTicket> {
    const now = this.deps.config.clock.now();
    const ticket = createSupportTicket({
      id: this.deps.config.ids(),
      subject: command.subject,
      description: command.description,
      category: command.category,
      priority: command.priority,
      requester: {
        userId: requesterUserId,
        email: command.email,
        organizationId: command.organizationId,
      },
      now,
    });
    await this.tickets.save(ticket);
    this.deps.logger.info('support.ticket_submitted', {
      ticketId: ticket.id,
      category: ticket.category,
      priority: ticket.priority,
      requesterUserId,
    });
    return ticket;
  }

  async listMyTickets(requesterUserId: EntityId, query: PaginationQuery) {
    return this.tickets.listByRequester(requesterUserId, query);
  }

  async getMyTicket(requesterUserId: EntityId, ticketId: EntityId): Promise<SupportTicket> {
    const ticket = await this.requireTicket(ticketId);
    if (ticket.requester.userId !== requesterUserId) {
      // Do not reveal the ticket exists for another requester.
      throw new NotFoundError('support_ticket', ticketId);
    }
    return ticket;
  }

  async sendMessage(
    requesterUserId: EntityId,
    ticketId: EntityId,
    content: string,
  ): Promise<SupportTicket> {
    const ticket = await this.getMyTicket(requesterUserId, ticketId);
    const now = this.deps.config.clock.now();
    const updated = addCustomerMessage(ticket, content, now);
    await this.tickets.save(updated);
    this.deps.logger.info('support.customer_message', { ticketId, requesterUserId });
    return updated;
  }

  private async requireTicket(ticketId: EntityId): Promise<SupportTicket> {
    const ticket = await this.tickets.getById(ticketId);
    if (!ticket) throw new NotFoundError('support_ticket', ticketId);
    if (ticket.deletedAt) throw new NotFoundError('support_ticket', ticketId);
    return ticket;
  }
}
