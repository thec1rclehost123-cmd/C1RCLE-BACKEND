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
  OrganizationCalendar,
  OrganizationEventCard,
  OrganizationOverview,
  OrganizationTrends,
  TopEvent,
  TrendBucket,
  TrendGranularity,
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

/** Hard cap on a trends range. A year of daily points is more than any chart here plots. */
const MAX_TREND_BUCKETS = 400;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** `YYYY-MM-DD` for an instant. */
function dayOf(instant: string): string {
  return instant.slice(0, 10);
}

/**
 * Normalises a requested range into inclusive bucket keys at `granularity`.
 *
 * Two jobs, both defensive:
 *
 *  - Reversed bounds are **swapped**, not rejected, so a mistyped range cannot
 *    500 a dashboard.
 *  - The key list is **clamped** to {@link MAX_TREND_BUCKETS}. The caller
 *    supplies both ends, so an unbounded range would otherwise let one request
 *    ask for a decade and force the scan to walk the whole order collection.
 *
 * An unparseable bound is normalised to a single bucket rather than throwing:
 * a non-finite bucket count would make the fill loop below non-terminating.
 * The route's own zod validation has already rejected malformed input before we
 * get here, so this is a backstop, not the primary guard.
 */
function buildRange(
  from: string,
  to: string,
  granularity: TrendGranularity,
): { from: string; to: string; keys: string[]; keyOf: (instant: string) => string } {
  const [earlier, later] = from <= to ? [from, to] : [to, from];
  const start = Date.parse(`${earlier}T00:00:00.000Z`);
  const end = Date.parse(`${later}T00:00:00.000Z`);

  const startMs = Number.isNaN(start) ? Date.parse(dayOf(new Date().toISOString())) : start;
  // `start` and `end` may both be NaN; the fallback above guarantees one real
  // value, and clamping `end` to it keeps the span non-negative.
  const endMs = Number.isNaN(end) ? startMs : Math.max(end, startMs);

  const keyOf = (instant: string): string =>
    granularity === 'hour'
      ? `${dayOf(instant)}T${instant.slice(11, 13)}:00`
      : granularity === 'month'
        ? instant.slice(0, 7)
        : dayOf(instant);

  const count = Math.min(Math.max(bucketCount(startMs, endMs, granularity), 1), MAX_TREND_BUCKETS);

  const keys: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const iso = new Date(bucketStart(startMs, index, granularity)).toISOString();
    keys.push(granularity === 'month' ? iso.slice(0, 7) : keyOf(iso));
  }

  return { from: keys[0] ?? earlier, to: keys.at(-1) ?? later, keys, keyOf };
}

/**
 * How many buckets `[start, end]` spans, inclusive at both ends.
 *
 * Both bounds are **midnights of whole days**, because that is what the route
 * accepts (`from`/`to` are `YYYY-MM-DD`). That matters at the fine granularities:
 * measuring an hourly span in hours between two midnights would make a
 * same-day request span zero hours and return a single bucket, and a month span
 * divided by an averaged 30-day month drifts by days per year until it silently
 * drops or invents a bucket. So each granularity counts in its own natural unit.
 */
function bucketCount(startMs: number, endMs: number, granularity: TrendGranularity): number {
  if (granularity === 'hour') {
    // The range is inclusive of the whole `to` day, so that day contributes all
    // 24 of its hours rather than just the 00:00 one.
    return (Math.floor((endMs - startMs) / DAY_MS) + 1) * 24;
  }
  if (granularity === 'month') {
    const startDate = new Date(startMs);
    const endDate = new Date(endMs);
    const months =
      (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
      (endDate.getUTCMonth() - startDate.getUTCMonth()) +
      1;
    return months;
  }
  return Math.floor((endMs - startMs) / DAY_MS) + 1;
}

function bucketStart(startMs: number, index: number, granularity: TrendGranularity): number {
  if (granularity === 'month') return addMonths(startMs, index);
  return startMs + index * (granularity === 'hour' ? HOUR_MS : DAY_MS);
}

function addMonths(fromMs: number, index: number): number {
  const date = new Date(fromMs);
  // Set the day to 1 first: `Date.UTC(2026, 1, 31)` would roll into March, so
  // adding months to a mid-month start would drift across month boundaries.
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + index, 1);
}

/** Weekday index with 0 = Monday, matching a Monday-first month grid. */
function dayOfWeekIndex(instant: Date): number {
  return (instant.getUTCDay() + 6) % 7;
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

  /** Source-backed ticket and collection metrics; never inferred by the UI. */
  async getOrganizationSalesBreakdown(actor: ActorContext): Promise<OrganizationSalesBreakdown> {
    requireOrgAccess(actor, actor.organizationId);
    const [orders, entitlements] = await Promise.all([
      this.scanAll<Order>((q) =>
        this.deps.repositories.orders.listByOrganization(actor.organizationId, q),
      ),
      this.scanAll<Entitlement>((q) =>
        this.deps.repositories.entitlements.listByOrganization(actor.organizationId, q),
      ),
    ]);

    const captured = orders.filter((order) => isCaptured(order.status));
    const rsvpOrderIds = new Set(
      captured.filter((order) => order.id.startsWith('RSVP-')).map((order) => order.id),
    );
    const paidOrders = captured.filter(
      (order) => !rsvpOrderIds.has(order.id) && order.lines.some((line) => line.unitPricePaise > 0),
    );
    const paidOrderIds = new Set(paidOrders.map((order) => order.id));

    return {
      totalTicketsIssued: entitlements.length,
      paidTickets: entitlements.filter((ticket) => paidOrderIds.has(ticket.orderId)).length,
      freeRsvpTickets: entitlements.filter((ticket) => rsvpOrderIds.has(ticket.orderId)).length,
      paidOrderCount: paidOrders.length,
      // Gross captured includes platform fees and tax, and is intentionally
      // before refunds. Ticket revenue is the discounted ticket subtotal,
      // excluding guest fees/tax, also before refunds.
      guestGrossCollectedPaise: paidOrders.reduce((sum, order) => sum + order.grandTotalPaise, 0),
      ticketRevenuePaise: paidOrders.reduce((sum, order) => sum + order.discountedSubtotalPaise, 0),
    };
  }

  async getEventAnalytics(actor: ActorContext, eventId: EntityId): Promise<EventAnalytics> {
    const events = this.deps.repositories.events;
    const event = await events.getById(eventId);
    if (!event || event.organizationId !== actor.organizationId) {
      // IDOR guard: do not reveal existence across tenants.
      throw new EventNotFoundError(eventId);
    }
    const analytics = await this.repo.getEventAnalytics(eventId);
    // Keep source-derived values fresh even when an older/stale projection is
    // present. In particular, legacy projections may encode an unconfigured
    // venue as capacity=0 and mark every future ticket as a no-show. Views,
    // guest-list signups, and conversion are projection-only, so retain those
    // fields from the read model while recomputing the financial/attendance
    // values from source aggregates.
    const computed = await this.computeEventAnalytics(event);
    if (!analytics) return computed;
    return {
      ...computed,
      views: analytics.views,
      guestlistSignups: analytics.guestlistSignups,
      conversionRate: analytics.conversionRate,
    };
  }

  /**
   * Revenue / tickets / check-ins for `[from, to]` inclusive, bucketed by
   * `granularity` and zero-filled across the whole range.
   *
   * Derived on request from the same bounded scan as
   * `computeOrganizationOverview`, for the same reason: the projection that
   * would own this has not shipped, and returning a flat zero series for an org
   * with real sales is worse than an honest scan.
   *
   * Granularity exists because a dashboard's ranges are genuinely different
   * shapes, not one range at three zooms: "today" wants hours, "this week"
   * wants days, "all time" wants months. Coarsening 24 hourly points into one
   * daily point — or asking for 400 daily points to draw 12 bars — would be
   * either useless or unreadable.
   *
   * The bucket count is clamped (see {@link MAX_TREND_BUCKETS}). An unbounded
   * range would turn one dashboard request into a whole-collection scan, and a
   * year of daily points is more than any chart here renders.
   */
  async getOrganizationTrends(
    actor: ActorContext,
    from: string,
    to: string,
    granularity: TrendGranularity = 'day',
  ): Promise<OrganizationTrends> {
    requireOrgAccess(actor, actor.organizationId);
    const range = buildRange(from, to, granularity);

    const [orderList, entitlementList] = await Promise.all([
      this.scanAll<Order>((q) =>
        this.deps.repositories.orders.listByOrganization(actor.organizationId, q),
      ),
      this.scanAll<Entitlement>((q) =>
        this.deps.repositories.entitlements.listByOrganization(actor.organizationId, q),
      ),
    ]);

    const buckets = new Map<string, TrendBucket>();
    for (const key of range.keys) {
      buckets.set(key, {
        key,
        revenuePaise: 0,
        tickets: 0,
        checkIns: 0,
        totalTicketsIssued: 0,
        paidTickets: 0,
        freeRsvpTickets: 0,
        paidOrderCount: 0,
        guestGrossCollectedPaise: 0,
        ticketRevenuePaise: 0,
      });
    }

    const ordersById = new Map(orderList.map((order) => [order.id, order]));
    for (const order of orderList) {
      if (!isCaptured(order.status)) continue;
      const bucket = buckets.get(range.keyOf(order.paidAt ?? order.createdAt));
      // An order outside the window is skipped, not clamped — clamping would
      // pile a whole month of sales onto its first or last bucket.
      if (bucket === undefined) continue;
      bucket.revenuePaise += netPaise(order);
      bucket.tickets += ticketsIn(order);
      if (!order.id.startsWith('RSVP-') && order.lines.some((line) => line.unitPricePaise > 0)) {
        bucket.paidOrderCount += 1;
        bucket.guestGrossCollectedPaise += order.grandTotalPaise;
        bucket.ticketRevenuePaise += order.discountedSubtotalPaise;
      }
    }

    // `scannedAt` is a list of instants, one per scan, so a ticket admitted on
    // the 1st and re-scanned on the 3rd counts in *both* buckets. Attributing a
    // multi-day entitlement to a single arbitrary day would make the per-day
    // check-in bars disagree with the total, which counts every scan.
    for (const entry of entitlementList) {
      const order = ordersById.get(entry.orderId);
      const issueBucket = buckets.get(range.keyOf(entry.createdAt));
      if (issueBucket !== undefined) {
        issueBucket.totalTicketsIssued += 1;
        if (order && isCaptured(order.status)) {
          if (order.id.startsWith('RSVP-')) issueBucket.freeRsvpTickets += 1;
          else if (order.lines.some((line) => line.unitPricePaise > 0))
            issueBucket.paidTickets += 1;
        }
      }
      for (const instant of entry.scannedAt) {
        const bucket = buckets.get(range.keyOf(instant));
        if (bucket !== undefined) bucket.checkIns += 1;
      }
    }

    return {
      organizationId: actor.organizationId,
      granularity,
      from: range.from,
      to: range.to,
      buckets: [...buckets.values()],
      totals: [...buckets.values()].reduce(
        (totals, bucket) => ({
          revenuePaise: totals.revenuePaise + bucket.revenuePaise,
          tickets: totals.tickets + bucket.tickets,
          checkIns: totals.checkIns + bucket.checkIns,
          totalTicketsIssued: totals.totalTicketsIssued + bucket.totalTicketsIssued,
          paidTickets: totals.paidTickets + bucket.paidTickets,
          freeRsvpTickets: totals.freeRsvpTickets + bucket.freeRsvpTickets,
          paidOrderCount: totals.paidOrderCount + bucket.paidOrderCount,
          guestGrossCollectedPaise:
            totals.guestGrossCollectedPaise + bucket.guestGrossCollectedPaise,
          ticketRevenuePaise: totals.ticketRevenuePaise + bucket.ticketRevenuePaise,
        }),
        {
          revenuePaise: 0,
          tickets: 0,
          checkIns: 0,
          totalTicketsIssued: 0,
          paidTickets: 0,
          freeRsvpTickets: 0,
          paidOrderCount: 0,
          guestGrossCollectedPaise: 0,
          ticketRevenuePaise: 0,
        },
      ),
    };
  }

  /**
   * Per-day event counts for `month` (`YYYY-MM`), for the overview's month grid.
   *
   * A pure function of the event list plus a `YYYY-MM` string — no scan of
   * orders — so it is cheap enough to call on every dashboard render. Buckets
   * every day of the month, including days with no events, because the grid
   * needs the full month to lay out and a gap would be read as "no data".
   */
  /**
   * Upcoming events as overview cards, soonest first.
   *
   * One scan of the organization's events rather than one
   * `GET /events/:id/analytics` per card: the dashboard shows a handful of
   * cards, and the per-event route would make page load a fan-out of N bounded
   * scans to answer a question this already has all the inputs for.
   *
   * `capacity` stays `null` when the venue never declared one. Zero would be a
   * lie the UI cannot distinguish from "sold out of a 0-capacity room", and the
   * card divides by it.
   */
  async getOrganizationEventCards(
    actor: ActorContext,
    limit: number,
  ): Promise<OrganizationEventCard[]> {
    requireOrgAccess(actor, actor.organizationId);
    const { events, orders, venues } = this.deps.repositories;

    const eventList = await this.scanAll<Event>((q) =>
      events.listByOrganization(actor.organizationId, q),
    );
    const orderList = await this.scanAll<Order>((q) =>
      orders.listByOrganization(actor.organizationId, q),
    );

    // "Upcoming" is purely temporal. Filtering on `isPublicStatus` here would
    // hide a partner's own *draft* from their dashboard, which is the one event
    // they most want to see sell-through on before publishing — and these cards
    // are tenant-scoped, never guest-facing, so publication is irrelevant.
    // `cancelled` and `archived` are still excluded: those are not "next up".
    const now = new Date().toISOString();
    const upcoming = eventList
      .filter(
        (event) =>
          event.startAt >= now && event.status !== 'cancelled' && event.status !== 'archived',
      )
      .sort((left, right) => left.startAt.localeCompare(right.startAt))
      .slice(0, limit);

    const soldByEvent = new Map<EntityId, number>();
    for (const order of orderList) {
      if (!isCaptured(order.status)) continue;
      const key = order.eventId;
      soldByEvent.set(key, (soldByEvent.get(key) ?? 0) + ticketsIn(order));
    }

    // Distinct venue ids only: the same venue on ten cards must be fetched once.
    const venueIds = [
      ...new Set(upcoming.flatMap((event) => (event.venueId ? [event.venueId] : []))),
    ];
    const resolved = await Promise.all(
      venueIds.map(async (id) => ({ id, venue: await venues.getById(id) })),
    );
    // A deleted venue resolves to `null` and yields a `null` name, which is the
    // honest answer — better than showing a name for a venue that no longer exists.
    const byVenue = new Map(resolved.map((entry) => [entry.id, entry.venue]));

    return upcoming.map((event) => {
      const venue = event.venueId ? byVenue.get(event.venueId) : undefined;
      return {
        eventId: event.id,
        title: event.title,
        startAt: event.startAt,
        status: event.status,
        venueId: event.venueId,
        venueName: venue?.public.name ?? null,
        imageUrl: event.imageUrl,
        ticketsSold: soldByEvent.get(event.id) ?? 0,
        // `public.capacity` is nullable by design (a venue may never declare
        // one), and that `null` must survive to the wire as `null`.
        capacity: venue?.public.capacity ?? null,
      };
    });
  }

  async getOrganizationCalendar(actor: ActorContext, month: string): Promise<OrganizationCalendar> {
    requireOrgAccess(actor, actor.organizationId);
    const eventList = await this.scanAll<Event>((q) =>
      this.deps.repositories.events.listByOrganization(actor.organizationId, q),
    );

    const firstDay = `${month}-01T00:00:00.000Z`;
    const year = Number(month.slice(0, 4));
    const monthIndex = Number(month.slice(5, 7)) - 1;
    const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

    const counts = new Array<number>(daysInMonth + 1).fill(0);
    for (const event of eventList) {
      // `archived` and `cancelled` events are not "something happening" — they
      // would render as a strike on the calendar the user can click into.
      if (event.status === 'archived' || event.status === 'cancelled') continue;
      if (!event.startAt.startsWith(month)) continue;
      const day = Number(event.startAt.slice(8, 10));
      // Guards a malformed `startAt` (e.g. `2026-02-31T…`) that would
      // otherwise scatter onto the wrong index or past the end of the array.
      if (!Number.isInteger(day) || day < 1 || day > daysInMonth) continue;
      // `counts` is length `daysInMonth + 1` and the guard above bounds `day`,
      // so the slot is always present; `noUncheckedIndexedAccess` cannot see
      // that, and `?? 0` would silently discard a bug rather than surface it.
      const slot = counts[day];
      if (slot === undefined) continue;
      counts[day] = slot + 1;
    }

    return {
      organizationId: actor.organizationId,
      month,
      firstDayOffset: dayOfWeekIndex(new Date(firstDay)),
      days: counts.slice(1).map((eventCount, index) => ({ day: index + 1, eventCount })),
    };
  }

  /** Walks the cursor until the page is exhausted or the scan cap is hit. */ private async scanAll<
    T,
  >(query: (page: PaginationQuery) => Promise<Page<T>>): Promise<T[]> {
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
    const { orders, entitlements } = this.deps.repositories;

    const [orderList, entitlementList, tiers] = await Promise.all([
      this.scanAll<Order>((q) => orders.listByEvent(event.id, q)),
      this.scanAll<Entitlement>((q) => entitlements.listByEvent(event.id, q)),
      this.deps.repositories.catalog.listTiers(event.id),
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

    // Event operations and door occupancy use the event's explicitly declared
    // legal room capacity. Ticket-tier quantities are inventory, and the
    // venue's default capacity must not silently override an event-level null.
    const capacity = event.capacity;

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
      totalTicketInventory: tiers.reduce((sum, tier) => sum + tier.quantity, 0),
      capacity,
      // Projection-only in the cached model; no source aggregate exists yet.
      views: 0,
      guestlistSignups: 0,
      avgTicketPricePaise: ticketsSold > 0 ? Math.round(totalRevenuePaise / ticketsSold) : 0,
      occupancyRate: capacity === null ? null : ratio(totalCheckIns, capacity),
      sellThroughRate: capacity === null ? null : ratio(ticketsSold, capacity),
      refundAmountPaise,
      refundRate: ratio(refundAmountPaise, totalRevenuePaise),
      // A no-show is only knowable after the event's declared end. A future or
      // in-progress event must not count every unscanned ticket as a no-show.
      noShowRate:
        event.endAt && Date.parse(event.endAt) <= Date.now() && ticketsSold > 0
          ? Math.min(1, Math.max(0, (ticketsSold - totalCheckIns) / ticketsSold))
          : null,
      repeatGuests: repeatGuests.size,
      conversionRate: 0,
    };
  }
}

export interface OrganizationSalesBreakdown {
  /** Historical entitlement records, including ones later voided. */
  readonly totalTicketsIssued: number;
  /** Issued entitlement units whose source order is a captured, paid-ticket order. */
  readonly paidTickets: number;
  /** Issued entitlement units from deterministic free-RSVP orders. */
  readonly freeRsvpTickets: number;
  /** Captured non-RSVP orders containing at least one positive-price tier. */
  readonly paidOrderCount: number;
  /** Captured order grand totals (fees and tax included), before refunds. */
  readonly guestGrossCollectedPaise: number;
  /** Discounted ticket subtotals, excluding fees and tax, before refunds. */
  readonly ticketRevenuePaise: number;
}

function startAtFor(events: Event[], eventId: EntityId): string {
  return events.find((event) => event.id === eventId)?.startAt ?? new Date(0).toISOString();
}
