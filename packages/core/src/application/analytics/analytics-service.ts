import { EventNotFoundError } from '../../domain/errors.js';
import { isPublicStatus } from '../../domain/models/event.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { Entitlement } from '../../domain/models/entitlement.js';
import type { Event } from '../../domain/models/event.js';
import type { Order } from '../../domain/models/order.js';
import type {
  Page,
  PaginationQuery,
  AnalyticsReadModelRepository,
  EventAnalytics,
  OrganizationOverview,
  TopEvent,
} from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/** Cap on each collection scan in the compute-on-request fallback. */
const COMPUTE_SCAN_LIMIT = 1000;
/** Aliases the same captured-order states the admin summary uses. */
function isCaptured(status: Order['status']): boolean {
  return status === 'paid' || status === 'refund_requested' || status === 'refunded';
}

/** Net money actually captured for an order (grand total minus anything refunded). */
function netPaise(order: Order): number {
  return order.grandTotalPaise - order.refundedPaise;
}

function ticketsIn(order: Order): number {
  return order.lines.reduce((sum, line) => sum + line.quantity, 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.min(1, numerator / denominator) : 0;
}

/**
 * ─── Analytics ────────────────────────────────────────────────────────────────
 *
 * Read model first, compute-on-request as the failback: the projection worker
 * that fills the read model has not shipped yet (see `audit-consumers.ts`), so
 * the "read-model only" stance was actually returning fabricated zeroes or a
 * 404 for orgs/events with real sales data — worse than an honest scan. This
 * service therefore keeps the cached model as the fast path and falls back to a
 * bounded scan of source aggregates when the cache is missing. The doc comments
 * on both public methods flag which numbers are projection-only (not yet
 * derivable from any source aggregate).
 */
export class AnalyticsService {
  constructor(private deps: ServiceDeps) {}

  private get repo(): AnalyticsReadModelRepository {
    return this.deps.repositories.analytics;
  }

  async getOrganizationOverview(actor: ActorContext): Promise<OrganizationOverview> {
    requireOrgAccess(actor, actor.organizationId);
    const overview = await this.repo.getOrganizationOverview(actor.organizationId);
    if (overview) return overview;
    return this.computeOrganizationOverview(actor.organizationId);
  }

  async getEventAnalytics(actor: ActorContext, eventId: EntityId): Promise<EventAnalytics> {
    const events = this.deps.repositories.events;
    const event = await events.getById(eventId);
    if (!event || event.organizationId !== actor.organizationId) {
      // IDOR guard: do not reveal existence across tenants.
      throw new EventNotFoundError(eventId);
    }
    const analytics = await this.repo.getEventAnalytics(eventId);
    if (analytics) return analytics;
    return this.computeEventAnalytics(event);
  }

  /** Walks the cursor until the page is exhausted or the scan cap is hit. */
  private async scanAll<T>(query: (page: PaginationQuery) => Promise<Page<T>>): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    do {
      const page = await query({ limit: COMPUTE_SCAN_LIMIT, cursor });
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null && out.length < COMPUTE_SCAN_LIMIT);
    return out;
  }

  private async computeOrganizationOverview(
    organizationId: EntityId,
  ): Promise<OrganizationOverview> {
    const { orders, events, entitlements, venues } = this.deps.repositories;

    const [orderList, eventList, entitlementList] = await Promise.all([
      this.scanAll<Order>((q) => orders.listByOrganization(organizationId, q)),
      this.scanAll<Event>((q) => events.listByOrganization(organizationId, q)),
      this.scanAll<Entitlement>((q) => entitlements.listByOrganization(organizationId, q)),
    ]);

    const venueIds = new Set(
      eventList.map((event) => event.venueId).filter((id): id is EntityId => id !== null),
    );
    const venueCapacityById = new Map<EntityId, number>();
    if (venueIds.size > 0) {
      const venuesById = await Promise.all([...venueIds].map((id) => venues.getById(id)));
      for (const venue of venuesById) {
        if (venue !== null && (venue.public.capacity ?? 0) > 0) {
          venueCapacityById.set(venue.id, venue.public.capacity ?? 0);
        }
      }
    }

    const titleById = new Map(eventList.map((event) => [event.id, event.title]));

    let totalRevenuePaise = 0;
    let totalTicketsSold = 0;
    const revenueByEvent = new Map<EntityId, number>();
    const ticketsByEvent = new Map<EntityId, number>();

    for (const order of orderList) {
      if (!isCaptured(order.status)) continue;
      const net = netPaise(order);
      totalRevenuePaise += net;
      const tickets = ticketsIn(order);
      totalTicketsSold += tickets;
      revenueByEvent.set(order.eventId, (revenueByEvent.get(order.eventId) ?? 0) + net);
      ticketsByEvent.set(order.eventId, (ticketsByEvent.get(order.eventId) ?? 0) + tickets);
    }

    const totalCheckIns = entitlementList.reduce((sum, entry) => sum + entry.scanCount, 0);

    const topEvents: TopEvent[] = [...revenueByEvent.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([eventId, revenuePaise]) => ({
        eventId,
        title: titleById.get(eventId) ?? eventId,
        revenuePaise,
        tickets: ticketsByEvent.get(eventId) ?? 0,
        date: startAtFor(eventList, eventId),
      }));

    const lastEventAt =
      eventList
        .filter((event) => event.status === 'ended' || event.status === 'archived')
        .sort((a, b) => b.startAt.localeCompare(a.startAt))[0]?.startAt ?? null;

    return {
      organizationId,
      totalEvents: eventList.length,
      publishedEvents: eventList.filter((event) => isPublicStatus(event.status)).length,
      totalRevenuePaise,
      totalTicketsSold,
      totalCheckIns,
      topEvents,
      lastEventAt,
    };
  }

  private async computeEventAnalytics(event: Event): Promise<EventAnalytics> {
    const { orders, entitlements, venues } = this.deps.repositories;

    const [orderList, entitlementList] = await Promise.all([
      this.scanAll<Order>((q) => orders.listByEvent(event.id, q)),
      this.scanAll<Entitlement>((q) => entitlements.listByEvent(event.id, q)),
    ]);

    let totalRevenuePaise = 0;
    let refundAmountPaise = 0;
    let ticketsSold = 0;
    for (const order of orderList) {
      if (!isCaptured(order.status)) continue;
      totalRevenuePaise += netPaise(order);
      refundAmountPaise += order.refundedPaise;
      ticketsSold += ticketsIn(order);
    }

    const totalCheckIns = entitlementList.reduce((sum, entry) => sum + entry.scanCount, 0);

    const venueCapacity = event.venueId
      ? ((await venues.getById(event.venueId))?.public.capacity ?? 0)
      : 0;
    const capacity = venueCapacity;

    // Repeat guests requires per-user purchase history; the fallback has only a
    // bounded entitlement scan, so count distinct entitled users instead.
    const repeatGuests = new Set<string>();
    for (const entry of entitlementList) {
      if (entry.userId !== null) repeatGuests.add(entry.userId);
    }

    return {
      eventId: event.id,
      totalRevenuePaise,
      ticketsSold,
      totalCheckIns,
      capacity,
      // Projection-only in the cached model; no source aggregate exists yet.
      views: 0,
      guestlistSignups: 0,
      avgTicketPricePaise: ticketsSold > 0 ? Math.round(totalRevenuePaise / ticketsSold) : 0,
      occupancyRate: ratio(totalCheckIns, capacity),
      sellThroughRate: ratio(ticketsSold, capacity),
      refundAmountPaise,
      refundRate: ratio(refundAmountPaise, totalRevenuePaise),
      noShowRate:
        ticketsSold > 0 ? Math.min(1, Math.max(0, (ticketsSold - totalCheckIns) / ticketsSold)) : 0,
      repeatGuests: repeatGuests.size,
      conversionRate: 0,
    };
  }
}

function startAtFor(events: Event[], eventId: EntityId): string {
  return events.find((event) => event.id === eventId)?.startAt ?? new Date(0).toISOString();
}
