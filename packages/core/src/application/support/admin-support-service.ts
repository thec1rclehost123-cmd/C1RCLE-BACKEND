import { NotFoundError } from '../../domain/errors.js';
import {
  addAdminReply,
  addInternalNote,
  assignTicket,
  changeTicketPriority,
  closeTicket,
  deleteTicket,
  escalateTicket,
  linkTicket,
  mergeDuplicateTicket,
  reopenTicket,
  resolveTicket,
  restoreTicket,
} from '../../domain/models/support-ticket.js';

import type { EntityId } from '../../domain/identity.js';
import type { SupportTicket, SupportTicketPriority } from '../../domain/models/support-ticket.js';
import type { AuditRequestMeta } from '../../domain/ports/audit.js';
import type { Page, PaginationQuery, SupportTicketQuery } from '../../domain/ports/repositories.js';
import type { AdminAuthorityService } from '../admin/admin-authority-service.js';
import type { ServiceDeps } from '../context.js';

/**
 * ─── Admin support desk service (Phase 7) ────────────────────────────────────
 *
 * The v1 desk's SUPPORT_* actions, re-homed over the real
 * `SupportTicket` aggregate (see `domain/models/support-ticket.ts`).
 *
 * Every mutation is TIER1 by the `admin-authority.ts` between-tiers rule:
 * any platform admin may act, every action is logged with before/after state
 * (`SUPPORT_ASSIGN`, `SUPPORT_RESOLVE`, … live only as *audit actions* here
 * — deliberately not added to `AdminAction`, because TIER1 needs no
 * per-role gate, only the audit trail). `requireAdmin` is the single guard.
 */

export interface AssignAgentInput {
  userId: EntityId;
  name: string;
}

export interface SupportLinkInput {
  venueId?: EntityId;
  eventId?: EntityId;
  orderId?: EntityId;
  organizationId?: EntityId;
  userId?: EntityId;
}

export class AdminSupportService {
  constructor(
    private deps: ServiceDeps,
    private authority: AdminAuthorityService,
  ) {}

  private get tickets() {
    return this.deps.repositories.supportTickets;
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async listTickets(
    adminUserId: EntityId,
    query: SupportTicketQuery,
    pagination: PaginationQuery,
  ): Promise<Page<SupportTicket>> {
    await this.authority.requireAdmin(adminUserId);
    return this.tickets.list(query, pagination);
  }

  async getTicket(adminUserId: EntityId, ticketId: EntityId): Promise<SupportTicket> {
    await this.authority.requireAdmin(adminUserId);
    return this.requireTicket(ticketId);
  }

  // ─── Desk mutations (all TIER1 — any admin, always audited) ──────────────

  async sendAdminReply(
    adminUserId: EntityId,
    ticketId: EntityId,
    content: string,
    meta?: AuditRequestMeta,
  ): Promise<SupportTicket> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const ticket = await this.requireTicket(ticketId);
    const now = this.deps.config.clock.now();
    const updated = addAdminReply(ticket, { userId: adminUserId, name: admin.email }, content, now);
    await this.tickets.save(updated);
    await this.authority.record(admin, {
      action: 'SUPPORT_REPLY',
      targetType: 'support_ticket',
      targetId: ticketId,
      before: { status: ticket.status, assignee: ticket.assignee?.userId ?? null },
      after: { status: updated.status },
      reason: content.slice(0, 80),
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    this.deps.logger.info('support.admin_reply', { ticketId });
    return updated;
  }

  async addNote(
    adminUserId: EntityId,
    ticketId: EntityId,
    content: string,
    meta?: AuditRequestMeta,
  ): Promise<SupportTicket> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const ticket = await this.requireTicket(ticketId);
    const now = this.deps.config.clock.now();
    const updated = addInternalNote(
      ticket,
      { userId: adminUserId, name: admin.email },
      content,
      now,
    );
    await this.tickets.save(updated);
    await this.authority.record(admin, {
      action: 'SUPPORT_ADD_INTERNAL_NOTE',
      targetType: 'support_ticket',
      targetId: ticketId,
      before: { internalNotes: ticket.internalNotes.length },
      after: { internalNotes: updated.internalNotes.length },
      reason: content.slice(0, 80),
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return updated;
  }

  async assign(
    adminUserId: EntityId,
    ticketId: EntityId,
    agent: AssignAgentInput,
    meta?: AuditRequestMeta,
  ): Promise<SupportTicket> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const ticket = await this.requireTicket(ticketId);
    const now = this.deps.config.clock.now();
    const updated = assignTicket(ticket, agent, now);
    await this.tickets.save(updated);
    await this.authority.record(admin, {
      action: 'SUPPORT_ASSIGN',
      targetType: 'support_ticket',
      targetId: ticketId,
      before: { status: ticket.status, assignee: ticket.assignee?.userId ?? null },
      after: { status: updated.status, assignee: updated.assignee?.userId ?? null },
      reason: `Assigned to ${agent.name}`,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return updated;
  }

  async changePriority(
    adminUserId: EntityId,
    ticketId: EntityId,
    priority: SupportTicketPriority,
    meta?: AuditRequestMeta,
  ): Promise<SupportTicket> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const ticket = await this.requireTicket(ticketId);
    const now = this.deps.config.clock.now();
    const updated = changeTicketPriority(ticket, priority, now);
    await this.tickets.save(updated);
    await this.authority.record(admin, {
      action: 'SUPPORT_CHANGE_PRIORITY',
      targetType: 'support_ticket',
      targetId: ticketId,
      before: { priority: ticket.priority, sla: ticket.sla },
      after: { priority: updated.priority, sla: updated.sla },
      reason: `Priority updated to ${priority}`,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return updated;
  }

  async link(
    adminUserId: EntityId,
    ticketId: EntityId,
    links: SupportLinkInput,
    meta?: AuditRequestMeta,
  ): Promise<SupportTicket> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const ticket = await this.requireTicket(ticketId);
    const now = this.deps.config.clock.now();
    const updated = linkTicket(ticket, links, adminUserId, now);
    await this.tickets.save(updated);
    await this.authority.record(admin, {
      action: 'SUPPORT_LINK',
      targetType: 'support_ticket',
      targetId: ticketId,
      before: { links: ticket.links },
      after: { links: updated.links },
      reason: 'Linked an entity to the ticket',
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return updated;
  }

  async escalate(
    adminUserId: EntityId,
    ticketId: EntityId,
    meta?: AuditRequestMeta,
  ): Promise<SupportTicket> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const ticket = await this.requireTicket(ticketId);
    const now = this.deps.config.clock.now();
    const updated = escalateTicket(ticket, adminUserId, now);
    await this.tickets.save(updated);
    await this.authority.record(admin, {
      action: 'SUPPORT_ESCALATE',
      targetType: 'support_ticket',
      targetId: ticketId,
      before: { status: ticket.status },
      after: { status: updated.status },
      reason: 'Escalated to technical team',
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return updated;
  }

  async resolve(
    adminUserId: EntityId,
    ticketId: EntityId,
    reason: string,
    meta?: AuditRequestMeta,
  ): Promise<SupportTicket> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const ticket = await this.requireTicket(ticketId);
    const now = this.deps.config.clock.now();
    const updated = resolveTicket(ticket, adminUserId, reason, now);
    await this.tickets.save(updated);
    await this.authority.record(admin, {
      action: 'SUPPORT_RESOLVE',
      targetType: 'support_ticket',
      targetId: ticketId,
      before: { status: ticket.status },
      after: { status: updated.status, resolvedAt: updated.resolvedAt },
      reason,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    this.deps.logger.info('support.resolved', { ticketId });
    return updated;
  }

  async close(
    adminUserId: EntityId,
    ticketId: EntityId,
    meta?: AuditRequestMeta,
  ): Promise<SupportTicket> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const ticket = await this.requireTicket(ticketId);
    const now = this.deps.config.clock.now();
    const updated = closeTicket(ticket, adminUserId, now);
    await this.tickets.save(updated);
    await this.authority.record(admin, {
      action: 'SUPPORT_CLOSE',
      targetType: 'support_ticket',
      targetId: ticketId,
      before: { status: ticket.status },
      after: { status: updated.status, closedAt: updated.closedAt },
      reason: 'Closed ticket',
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return updated;
  }

  async reopen(
    adminUserId: EntityId,
    ticketId: EntityId,
    meta?: AuditRequestMeta,
  ): Promise<SupportTicket> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const ticket = await this.requireTicket(ticketId);
    const now = this.deps.config.clock.now();
    const updated = reopenTicket(ticket, adminUserId, now);
    await this.tickets.save(updated);
    await this.authority.record(admin, {
      action: 'SUPPORT_REOPEN',
      targetType: 'support_ticket',
      targetId: ticketId,
      before: { status: ticket.status },
      after: { status: updated.status },
      reason: 'Reopened ticket',
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return updated;
  }

  async merge(
    adminUserId: EntityId,
    ticketId: EntityId,
    duplicateTicketId: EntityId,
    meta?: AuditRequestMeta,
  ): Promise<{ primary: SupportTicket; duplicate: SupportTicket }> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const primary = await this.requireTicket(ticketId);
    const duplicate = await this.requireTicket(duplicateTicketId);
    const now = this.deps.config.clock.now();
    const merged = mergeDuplicateTicket(primary, duplicate, adminUserId, now);
    await this.tickets.save(merged.primary);
    await this.tickets.save(merged.duplicate);
    await this.authority.record(admin, {
      action: 'SUPPORT_MERGE',
      targetType: 'support_ticket',
      targetId: ticketId,
      before: { status: primary.status, mergedInto: primary.mergedInto },
      after: {
        status: merged.primary.status,
        mergedFrom: merged.primary.mergedFrom,
        duplicateStatus: merged.duplicate.status,
        duplicateMergedInto: merged.duplicate.mergedInto,
      },
      reason: `Merged duplicate ticket ${duplicate.id} into primary ticket ${primary.id}`,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    this.deps.logger.info('support.merged', { primaryId: primary.id, duplicateId: duplicate.id });
    return merged;
  }

  async listMergedInto(adminUserId: EntityId, ticketId: EntityId): Promise<SupportTicket[]> {
    await this.authority.requireAdmin(adminUserId);
    return this.tickets.listByMergedInto(ticketId);
  }

  /** Soft delete with attribution — never a hard delete. */
  async delete(
    adminUserId: EntityId,
    ticketId: EntityId,
    meta?: AuditRequestMeta,
  ): Promise<SupportTicket> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const ticket = await this.requireTicket(ticketId);
    const now = this.deps.config.clock.now();
    const updated = deleteTicket(ticket, adminUserId, now);
    await this.tickets.save(updated);
    await this.authority.record(admin, {
      action: 'SUPPORT_DELETE',
      targetType: 'support_ticket',
      targetId: ticketId,
      before: { deletedAt: null },
      after: { deletedAt: updated.deletedAt, deletedBy: updated.deletedBy },
      reason: 'Soft-deleted ticket',
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return updated;
  }

  async restore(
    adminUserId: EntityId,
    ticketId: EntityId,
    meta?: AuditRequestMeta,
  ): Promise<SupportTicket> {
    const admin = await this.authority.requireAdmin(adminUserId);
    const ticket = await this.requireTicketIncludingDeleted(ticketId);
    const now = this.deps.config.clock.now();
    const updated = restoreTicket(ticket, adminUserId, now);
    await this.tickets.save(updated);
    await this.authority.record(admin, {
      action: 'SUPPORT_RESTORE',
      targetType: 'support_ticket',
      targetId: ticketId,
      before: { deletedAt: ticket.deletedAt, deletedBy: ticket.deletedBy },
      after: { deletedAt: null, deletedBy: null },
      reason: 'Restored ticket',
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return updated;
  }

  private async requireTicket(ticketId: EntityId): Promise<SupportTicket> {
    const ticket = await this.tickets.getById(ticketId);
    if (!ticket) throw new NotFoundError('support_ticket', ticketId);
    return ticket;
  }

  private async requireTicketIncludingDeleted(ticketId: EntityId): Promise<SupportTicket> {
    const ticket = await this.tickets.getById(ticketId, { includeDeleted: true });
    if (!ticket) throw new NotFoundError('support_ticket', ticketId);
    return ticket;
  }
}
