import { describe, expect, it, vi } from 'vitest';

import {
  createAnalyticsProjectionConsumer,
  refreshAnalyticsReadModel,
} from './analytics-projection.js';

import type { DomainEvent } from '../../domain/events.js';
import type { EventAnalytics, OrganizationOverview } from '../../domain/ports/repositories.js';
import type { Logger } from '../../telemetry/logger.js';

/**
 * ─── Analytics projection ────────────────────────────────────────────────────
 * Pins the projection's own logic — which rows it touches, in what order, how
 * the sweep pages, and that one row's failure never aborts the pass or the
 * consumer's siblings. The `compute*` numbers themselves are exercised through
 * the gateway's analytics routes; here the projector is a stub so the test is
 * about the wiring, not the arithmetic.
 */

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function event(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: 'evt_row_1',
    type: 'event.published',
    schemaVersion: 1,
    aggregateId: 'evt_1',
    organizationId: 'org_1',
    actorId: 'usr_1',
    payload: { title: 'Launch Night' },
    occurredAt: 1_700_000_000_000,
    ...overrides,
  };
}

function projector() {
  return {
    projectEventAnalytics: vi.fn(async (): Promise<EventAnalytics | null> => null),
    projectOrganizationOverview: vi.fn(async (): Promise<OrganizationOverview> => {
      return {} as OrganizationOverview;
    }),
  };
}

describe('createAnalyticsProjectionConsumer', () => {
  it('projects the event and its organization, event first', async () => {
    const analytics = projector();
    const consumer = createAnalyticsProjectionConsumer(analytics);

    await consumer(event());

    expect(analytics.projectEventAnalytics).toHaveBeenCalledWith('evt_1');
    expect(analytics.projectOrganizationOverview).toHaveBeenCalledWith('org_1');
    expect(analytics.projectEventAnalytics.mock.invocationCallOrder[0]).toBeLessThan(
      analytics.projectOrganizationOverview.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('is a named function — the bus keys dedupe by handler identity/name', () => {
    const consumer = createAnalyticsProjectionConsumer(projector());
    expect(consumer.name).toBe('analyticsProjectionConsumer');
  });

  it('propagates a repository failure so the bus retries it', async () => {
    const analytics = projector();
    analytics.projectEventAnalytics.mockRejectedValueOnce(new Error('firestore down'));
    const consumer = createAnalyticsProjectionConsumer(analytics);

    await expect(consumer(event())).rejects.toThrow('firestore down');
    expect(analytics.projectOrganizationOverview).not.toHaveBeenCalled();
  });
});

describe('refreshAnalyticsReadModel', () => {
  function paged<TItem extends { id: string }>(rows: TItem[]) {
    return vi.fn(async () => ({ items: rows, total: rows.length, nextCursor: null }));
  }

  it('projects every event and every organization', async () => {
    const analytics = projector();
    const events = { listAll: paged([{ id: 'evt_1' }, { id: 'evt_2' }]) };
    const organizations = { listAll: paged([{ id: 'org_1' }, { id: 'org_2' }, { id: 'org_3' }]) };

    const result = await refreshAnalyticsReadModel({
      analytics,
      events: events as never,
      organizations: organizations as never,
      logger: noopLogger,
    });

    expect(analytics.projectEventAnalytics).toHaveBeenCalledTimes(2);
    expect(analytics.projectEventAnalytics).toHaveBeenCalledWith('evt_2');
    expect(analytics.projectOrganizationOverview).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ events: 2, organizations: 3, failures: 0 });
  });

  it('counts a failed row without aborting the pass', async () => {
    const analytics = projector();
    analytics.projectEventAnalytics.mockRejectedValueOnce(new Error('bad event'));
    const logger = { ...noopLogger, error: vi.fn() };
    const events = { listAll: paged([{ id: 'evt_1' }, { id: 'evt_2' }]) };
    const organizations = { listAll: paged([{ id: 'org_1' }]) };

    const result = await refreshAnalyticsReadModel({
      analytics,
      events: events as never,
      organizations: organizations as never,
      logger,
    });

    expect(analytics.projectEventAnalytics).toHaveBeenCalledTimes(2); // evt_2 still ran
    expect(result).toEqual({ events: 1, organizations: 1, failures: 1 });
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('drains pages until the cursor is exhausted', async () => {
    const analytics = projector();
    const pages = [
      { items: [{ id: 'evt_1' }], total: 2, nextCursor: 'c1' },
      { items: [{ id: 'evt_2' }], total: 2, nextCursor: null },
    ];
    let call = 0;
    const events = {
      listAll: vi.fn(async () => pages[call++] ?? { items: [], total: 0, nextCursor: null }),
    };
    const organizations = { listAll: paged([]) };

    const result = await refreshAnalyticsReadModel({
      analytics,
      events: events as never,
      organizations: organizations,
      logger: noopLogger,
    });

    expect(result.events).toBe(2);
    expect(analytics.projectEventAnalytics).toHaveBeenCalledWith('evt_2');
  });

  it('terminates when a source repeats a cursor instead of looping forever', async () => {
    const analytics = projector();
    // A broken adapter that always hands back the same cursor: without the
    // seen-cursor guard this would spin until the process is killed.
    const events = {
      listAll: vi.fn(async () => ({ items: [{ id: 'evt_1' }], total: 1, nextCursor: 'stuck' })),
    };
    const organizations = { listAll: paged([]) };

    const result = await refreshAnalyticsReadModel({
      analytics,
      events: events as never,
      organizations: organizations,
      logger: noopLogger,
    });

    expect(result.events).toBe(2); // 'stuck' row read twice, then the guard breaks
    expect(events.listAll).toHaveBeenCalledTimes(2);
  });
});
