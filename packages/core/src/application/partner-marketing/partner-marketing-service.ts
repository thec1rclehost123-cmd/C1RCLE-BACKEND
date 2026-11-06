import { createHash } from 'node:crypto';

import { ForbiddenError, InvalidOperationError } from '../../domain/errors.js';
import { currentEntitlementHolderId } from '../../domain/models/entitlement.js';
import { fulfilmentPending } from '../../domain/models/fulfilment.js';
import { requireOrgAccess } from '../context.js';

import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/** Read-only projection. No contact fields, new audience database, or delivery eligibility. */
export class PartnerMarketingService {
  constructor(
    private repos: Pick<
      ServiceDeps['repositories'],
      'events' | 'orders' | 'entitlements' | 'catalog'
    >,
  ) {}
  private async collect<T>(read: (query: PaginationQuery) => Promise<Page<T>>) {
    const rows: T[] = [];
    let cursor: string | null = null;
    do {
      const page = await read({ cursor, limit: 200 });
      rows.push(...page.items);
      cursor = page.nextCursor;
      if (rows.length > 5000 || (rows.length >= 5000 && cursor)) {
        throw new InvalidOperationError(
          'Audience exceeds the current read limit. A dedicated audience index is required.',
        );
      }
    } while (cursor);
    return rows;
  }
  async tierPerformance(organizationId: string, actor: ActorContext, from: string, to: string) {
    requireOrgAccess(actor, organizationId);
    const [orders, events, entitlements] = await Promise.all([
      this.collect((q) => this.repos.orders.listByOrganization(organizationId, q)),
      this.collect((q) => this.repos.events.listByOrganization(organizationId, q)),
      this.collect((q) => this.repos.entitlements.listByOrganization(organizationId, q)),
    ]);
    const names = new Map(
      events.filter((e) => e.organizationId === organizationId).map((e) => [e.id, e.title]),
    );
    const grouped = new Map<
      string,
      { eventId: string; eventName: string; tierId: string; name: string; tickets: number }
    >();
    const channels = { promoter: 0, unattributed: 0 };
    const purchaseDays = Array<number>(7).fill(0);
    const captured = new Map<string, (typeof orders)[number]>();
    for (const order of orders) {
      if (
        order.organizationId !== organizationId ||
        !['paid', 'refund_requested', 'refunded'].includes(order.status)
      )
        continue;
      captured.set(order.id, order);
      if (!order.paidAt) continue;
      const day = order.paidAt.slice(0, 10);
      if (day < from || day > to) continue;
      const weekday = new Date(order.paidAt).getUTCDay();
      purchaseDays[weekday] = (purchaseDays[weekday] ?? 0) + 1;
    }
    // Count issued records, not order quantities or admitted people. M5 per-person
    // groups can issue multiple entitlements from one purchased group unit.
    for (const ticket of entitlements) {
      const order = captured.get(ticket.orderId);
      const issuedDay = ticket.createdAt.slice(0, 10);
      if (issuedDay < from || issuedDay > to) continue;
      if (!order || ticket.organizationId !== organizationId || ticket.eventId !== order.eventId)
        continue;
      channels[order.attribution?.promoterId ? 'promoter' : 'unattributed'] += 1;
      const key = JSON.stringify([ticket.eventId, ticket.tierId]);
      const row = grouped.get(key);
      if (row) row.tickets += 1;
      else
        grouped.set(key, {
          eventId: ticket.eventId,
          eventName: names.get(ticket.eventId) ?? 'Event unavailable',
          tierId: ticket.tierId,
          name: ticket.tierName,
          tickets: 1,
        });
    }
    return {
      rows: [...grouped.values()].sort((a, b) => b.tickets - a.tickets),
      channels,
      purchaseDays,
    };
  }
  async list(
    organizationId: string,
    actor: ActorContext,
    query: { search?: string; eventId?: string; tierId?: string; offset?: number },
  ) {
    requireOrgAccess(actor, organizationId);
    // Spend and audience are privileged: match the existing finance-order role boundary.
    if (
      !['owner', 'admin', 'manager'].includes(actor.role) ||
      !actor.capabilities.some((value) => value === 'host' || value === 'venue')
    ) {
      throw new ForbiddenError('Partner audience access required');
    }
    const [events, orders, tickets] = await Promise.all([
      this.collect((q) => this.repos.events.listByOrganization(organizationId, q)),
      this.collect((q) => this.repos.orders.listByOrganization(organizationId, q)),
      this.collect((q) => this.repos.entitlements.listByOrganization(organizationId, q)),
    ]);
    const eventMap = new Map(
      events.filter((e) => e.organizationId === organizationId).map((e) => [e.id, e]),
    );
    const tiers = (
      await Promise.all(
        [...eventMap.values()].map(async (event) =>
          (await this.repos.catalog.listTiers(event.id)).map((tier) => ({
            id: tier.id,
            eventId: event.id,
            name: tier.name,
          })),
        ),
      )
    ).flat();
    const spend = new Map<string, number>();
    for (const order of orders) {
      if (
        order.organizationId !== organizationId ||
        !order.userId ||
        !['paid', 'refund_requested', 'refunded'].includes(order.status)
      )
        continue;
      const key = JSON.stringify([order.eventId, order.userId]);
      spend.set(
        key,
        (spend.get(key) ?? 0) + Math.max(0, order.grandTotalPaise - order.refundedPaise),
      );
    }
    const orderById = new Map(
      orders
        .filter((order) => order.organizationId === organizationId)
        .map((order) => [order.id, order]),
    );
    const rows = new Map<
      string,
      {
        id: string;
        name: string;
        eventId: string;
        eventName: string;
        tickets: number;
        totalSpendPaise: number;
      }
    >();
    for (const ticket of tickets) {
      const event = eventMap.get(ticket.eventId);
      if (orderById.get(ticket.orderId)?.status === 'refunded') continue;
      if (fulfilmentPending(ticket, orderById.get(ticket.orderId) ?? null)) continue;
      if (
        !event ||
        ticket.organizationId !== organizationId ||
        ['cancelled', 'archived'].includes(event.status) ||
        ticket.status === 'void' ||
        ticket.refundLock
      )
        continue;
      if (query.eventId && event.id !== query.eventId) continue;
      if (query.tierId && ticket.tierId !== query.tierId) continue;
      if (ticket.pendingTransferId) {
        const transfer = await this.repos.entitlements.getTicketTransfer(ticket.pendingTransferId);
        if (!transfer || transfer.status === 'frozen') continue;
      }
      const holder = currentEntitlementHolderId(ticket);
      if (!holder) continue;
      const id = JSON.stringify([event.id, holder]);
      const existing = rows.get(id);
      if (existing) existing.tickets += 1;
      else
        rows.set(id, {
          id: createHash('sha256')
            .update(JSON.stringify([organizationId, event.id, holder]))
            .digest('hex'),
          name: ticket.holderName.trim() || 'Guest',
          eventId: event.id,
          eventName: event.title,
          tickets: 1,
          totalSpendPaise: spend.get(id) ?? 0,
        });
    }
    const search = query.search?.toLocaleLowerCase();
    const matching = [...rows.values()]
      .filter((row) => !search || row.name.toLocaleLowerCase().includes(search))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const offset = query.offset ?? 0;
    return {
      rows: matching.slice(offset, offset + 50),
      total: matching.length,
      nextOffset: offset + 50 < matching.length ? offset + 50 : null,
      events: [...eventMap.values()].map((e) => ({ id: e.id, name: e.title })),
      tiers,
    };
  }
}
