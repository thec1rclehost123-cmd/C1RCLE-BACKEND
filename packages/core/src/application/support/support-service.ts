import { NotFoundError } from '../../domain/errors.js';
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
