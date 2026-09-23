import { describe, expect, it } from 'vitest';

import { NotificationNotFoundError } from '../../domain/errors.js';
import { MemoryNotificationRepository } from '../../infrastructure/memory/memory-notification-repository.js';

import { createNotificationConsumer } from './notification-consumer.js';
import { NotificationService } from './notification-service.js';

import type { DomainEvent } from '../../domain/events.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * ─── Notification producer consumer + service (V2 inbox) ─────────────────────
 * The recipient-selection logic is the piece that matters most: the consumer
 * must address the OTHER party for connection/partnership requests and the
 * event's own org for publishes — never the registering org's mirror.
 */

const FIXED_NOW = new Date('2026-01-15T12:00:00.000Z');

interface Harness {
  repo: MemoryNotificationRepository;
  service: NotificationService;
  consume: (event: DomainEvent) => Promise<void>;
}

function makeHarness(): Harness {
  const repo = new MemoryNotificationRepository();
  let seq = 0;
  const deps = {
    repositories: { notifications: repo },
    config: { ids: () => `notif_${++seq}`, clock: { now: () => FIXED_NOW } },
    logger: { info: () => undefined },
  } as unknown as ServiceDeps;

  const service = new NotificationService(deps);
  const consume = createNotificationConsumer({
    notifications: repo,
    config: deps.config,
    logger: deps.logger,
  });
  return { repo, service, consume };
}

function event(type: string, overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: `evt_${Math.random().toString(36).slice(2, 8)}`,
    type,
    schemaVersion: 1,
    aggregateId: 'agg_1',
    organizationId: 'org_initiator',
    actorId: 'user_1',
    occurredAt: FIXED_NOW.getTime(),
    payload: {},
    ...overrides,
  };
}

const connectionRequested = (connectionId = 'conn_1', targetId = 'org_venue') =>
  event('promoter_connection.requested', {
    payload: {
      connectionId,
      targetId,
      targetType: 'venue',
      initiatedBy: 'promoter',
      promoterId: 'org_promoter',
      promoterName: 'Ace',
      message: null,
    },
  });

function firstOf(repo: MemoryNotificationRepository) {
  return Array.from(repo.entries.values())[0];
}

const actorOf = (organizationId: string): ActorContext => ({
  userId: 'user_1',
  organizationId,
  role: 'owner',
  capabilities: ['venue'],
});

describe('notification consumer — producer mapping', () => {
  it('addresses a connection request to the target org, not the initiator', async () => {
    const { repo, consume } = makeHarness();
    await consume(connectionRequested());

    const item = firstOf(repo);
    expect(item).toMatchObject({
      recipientId: 'org_venue',
      recipientType: 'venue',
      type: 'promoter_connection.requested',
      read: false,
      action: { resourceType: 'promoter_connection', resourceId: 'conn_1' },
    });
    expect(item?.title).toContain('Ace');
  });

  it('addresses a host-initiated partnership to the venue org', async () => {
    const { repo, consume } = makeHarness();
    await consume(
      event('partnership.requested', {
        payload: {
          partnershipId: 'ptn_1',
          venueId: 'ven_1',
          venueOrganizationId: 'org_venue',
          hostOrganizationId: 'org_host',
          initiatedBy: 'host',
          venueName: 'Sky Bar',
          hostName: 'Nocturne',
        },
      }),
    );

    expect(firstOf(repo)).toMatchObject({
      recipientId: 'org_venue',
      recipientType: 'venue',
      type: 'partnership.requested',
      action: { resourceType: 'partnership', resourceId: 'ptn_1' },
    });
  });

  it('addresses a venue-initiated partnership to the host org', async () => {
    const { repo, consume } = makeHarness();
    await consume(
      event('partnership.requested', {
        payload: {
          partnershipId: 'ptn_1',
          venueId: 'ven_1',
          venueOrganizationId: 'org_venue',
          hostOrganizationId: 'org_host',
          initiatedBy: 'venue',
          venueName: 'Sky Bar',
          hostName: 'Nocturne',
        },
      }),
    );

    expect(firstOf(repo)).toMatchObject({
      recipientId: 'org_host',
      recipientType: 'host',
      title: expect.stringContaining('Sky Bar'),
    });
  });

  it('addresses an event publish to the organising venue org', async () => {
    const { repo, consume } = makeHarness();
    await consume(
      event('event.published', { organizationId: 'org_venue', payload: { title: 'Sky Night' } }),
    );

    expect(firstOf(repo)).toMatchObject({
      recipientId: 'org_venue',
      recipientType: 'venue',
      type: 'event.published',
      title: expect.stringContaining('Sky Night'),
      action: null,
    });
  });

  it('ignores events it does not produce', async () => {
    const { repo, consume } = makeHarness();
    await consume(event('organization.created', { payload: { name: 'Org', slug: 'org' } }));
    expect(repo.entries.size).toBe(0);
  });
});

describe('notification service', () => {
  it('lists an inbox page with a live unread count', async () => {
    const { service, consume } = makeHarness();
    await consume(connectionRequested());
    await consume(
      event('partnership.requested', {
        payload: {
          partnershipId: 'ptn_1',
          venueId: 'ven_1',
          venueOrganizationId: 'org_venue',
          hostOrganizationId: 'org_host',
          initiatedBy: 'host',
          venueName: 'Sky Bar',
          hostName: 'Nocturne',
        },
      }),
    );
    const page = await service.list(actorOf('org_venue'), 'org_venue', { limit: 10 });
    expect(page.total).toBe(2);
    expect(page.unreadCount).toBe(2);
  });

  it('treats a notification of a foreign org as not-found on read', async () => {
    const { repo, service, consume } = makeHarness();
    await consume(connectionRequested('conn_1', 'org_venue'));
    const victim = firstOf(repo);
    if (!victim) throw new Error('expected a connection notification');

    await expect(service.markRead(actorOf('org_stranger'), victim.id)).rejects.toBeInstanceOf(
      NotificationNotFoundError,
    );
  });

  it('markRead is idempotent and markAllRead counts the unread rows it touched', async () => {
    const { service, consume } = makeHarness();
    await consume(connectionRequested('conn_1', 'org_venue'));
    await consume(connectionRequested('conn_2', 'org_venue'));
    const list = await service.list(actorOf('org_venue'), 'org_venue', {
      limit: 10,
    });
    const actor = actorOf('org_venue');
    const victim = list.items.find((item) => item.action?.resourceId === 'conn_1');
    if (!victim) throw new Error('expected a conn_1 notification');
    const victimId = victim.id;

    const once = await service.markRead(actor, victimId);
    const twice = await service.markRead(actor, victimId);
    expect(once.read).toBe(true);
    expect(twice.read).toBe(true);
    expect(twice.id).toBe(victimId);

    expect(await service.markAllRead(actor, 'org_venue')).toBe(1);
    const after = await service.list(actor, 'org_venue', { limit: 10 });
    expect(after.unreadCount).toBe(0);
  });
});
