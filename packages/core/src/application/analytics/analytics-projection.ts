/**
 * ─── Analytics projection ─────────────────────────────────────────────────────
 *
 * Fills the analytics read model (`AnalyticsReadModelRepository`) from domain
 * events, so a partner dashboard's first read is a document get rather than a
 * bounded scan. The read path keeps its compute-on-request fallback for rows
 * that do not exist yet (an org that predates this, a brand-new event) — both
 * paths call the same `compute*` methods, so a projected row and a fallback
 * answer agree by construction.
 *
 * Two writers exist, on purpose:
 *
 *  - `createAnalyticsProjectionConsumer` — reconciles an event's numbers when
 *    its lifecycle changes (created / published / cancelled). Runs on the bus,
 *    in the same call as the emitting write.
 *  - `refreshAnalyticsReadModel` — a full pass over every org and event. It is
 *    the backfill (one run against an existing database) and the periodic
 *    refresh the gateway drives (see `app.ts`). It exists because most of the
 *    money a dashboard shows moves on writes that emit NO event — an order
 *    captured, a ticket scanned — so an event-driven projection alone would
 *    freeze revenue and check-in totals between lifecycle changes.
 *
 * Both are idempotent: a row is a pure function of the source aggregates and
 * the adapter upserts, so an at-least-once redelivery (the bus dedupe is
 * in-memory only) writes the same numbers again.
 */

import type { AnalyticsService } from './analytics-service.js';
import type { DomainEvent } from '../../domain/events.js';
import type { EventRepository, OrganizationRepository } from '../../domain/ports/repositories.js';
import type { Logger } from '../../telemetry/logger.js';

/**
 * The event types whose lifecycle changes what analytics reports. `event.updated`
 * is included: a venue change moves an event between org roll-ups, and the
 * projection is the only thing that would notice until the next full refresh.
 */
export const ANALYTICS_PROJECTION_EVENT_TYPES = [
  'event.created',
  'event.updated',
  'event.published',
  'event.cancelled',
] as const;

/** Just the two write methods the projection needs — not the whole service. */
type AnalyticsProjector = Pick<
  AnalyticsService,
  'projectOrganizationOverview' | 'projectEventAnalytics'
>;

/**
 * Builds the bus consumer. The handler is a NAMED function on purpose — the bus
 * keys its dedupe set by handler identity, and a named function keeps the
 * diagnostics readable. Subscribed per event type by the caller (one instance
 * can back all four subscriptions).
 *
 * Errors propagate: the bus catches them, leaves the row pending, and retries
 * up to the outbox's max attempts before the DLQ — so a transient repository
 * failure does not silently drop a projection, and a failure here never fails
 * the request that emitted the event.
 */
export function createAnalyticsProjectionConsumer(analytics: AnalyticsProjector) {
  return analyticsProjectionConsumer;

  async function analyticsProjectionConsumer(event: DomainEvent): Promise<void> {
    // Event and org are projected together: an event's numbers only change with
    // its own lifecycle, but any lifecycle change also moves the org roll-up
    // (published count, top events), so projecting one without the other would
    // leave the overview stale exactly when it is most likely to be read.
    await analytics.projectEventAnalytics(event.aggregateId);
    await analytics.projectOrganizationOverview(event.organizationId);
  }
}

export interface AnalyticsRefreshDeps {
  analytics: AnalyticsProjector;
  events: Pick<EventRepository, 'listAll'>;
  organizations: Pick<OrganizationRepository, 'listAll'>;
  logger: Logger;
}

/** Bounded page size — the sweep reads the whole collection, not one row. */
const REFRESH_PAGE_SIZE = 100;

export interface AnalyticsRefreshResult {
  events: number;
  organizations: number;
  failures: number;
}

/**
 * Recomputes and stores every event's and every organization's read-model row.
 * Used as the one-shot backfill and as the gateway's periodic refresh.
 *
 * One row's failure does not abort the pass: the numbers are independent, and a
 * sweep that stops at the first bad event would leave everything after it
 * stale. Failures are counted and logged; the next pass retries them.
 */
export async function refreshAnalyticsReadModel(
  deps: AnalyticsRefreshDeps,
): Promise<AnalyticsRefreshResult> {
  let events = 0;
  let organizations = 0;
  let failures = 0;

  for (const event of await collectAll((query) => deps.events.listAll(query))) {
    try {
      await deps.analytics.projectEventAnalytics(event.id);
      events += 1;
    } catch (error: unknown) {
      failures += 1;
      deps.logger.error('analytics refresh: event projection failed', {
        eventId: event.id,
        error,
      });
    }
  }

  for (const organization of await collectAll((query) => deps.organizations.listAll(query))) {
    try {
      await deps.analytics.projectOrganizationOverview(organization.id);
      organizations += 1;
    } catch (error: unknown) {
      failures += 1;
      deps.logger.error('analytics refresh: organization projection failed', {
        organizationId: organization.id,
        error,
      });
    }
  }

  deps.logger.info('analytics refresh complete', { events, organizations, failures });
  return { events, organizations, failures };
}

/**
 * Drains a `listAll` page by page. `total` is not trusted as a loop bound
 * (some sources report 0), and neither is a cursor that never advances — the
 * `seen` guard makes a repeated cursor terminate instead of spinning.
 */
async function collectAll<TItem extends { id: string }>(
  page: (query: { limit: number; cursor: string | null }) => Promise<{
    items: TItem[];
    nextCursor: string | null;
  }>,
): Promise<TItem[]> {
  const out: TItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await page({ limit: REFRESH_PAGE_SIZE, cursor });
    out.push(...result.items);
    cursor = result.nextCursor;
    if (cursor !== null && seenCursors.has(cursor)) break;
    if (cursor !== null) seenCursors.add(cursor);
  } while (cursor !== null);
  return out;
}
