import { describe, expect, it } from 'vitest';

import { domainEvent } from '../../domain/events.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import {
  MemoryFollowRepository,
  MemorySocialNotificationRepository,
} from '../../infrastructure/memory/memory-social-repositories.js';
import { InProcessEventBus } from '../events/event-bus.js';

import { createFollowerFanOutConsumer } from './notification-consumers.js';
import { SocialService } from './social-service.js';

import type { DomainEvent } from '../../domain/events.js';
import type { Event } from '../../domain/models/event.js';
import type { ActorContext, ServiceDeps } from '../context.js';

const NOW = new Date('2026-09-29T10:00:00.000Z');

function guest(userId: string): ActorContext {
  return { userId, organizationId: '', role: 'owner', capabilities: [] };
}

function setup(opts: { event?: Partial<Event> | null } = {}) {
  const follows = new MemoryFollowRepository();
  const notifications = new MemorySocialNotificationRepository();
  const bus = new InProcessEventBus(new MemoryOutboxStore());
  const emitted: DomainEvent[] = [];
  bus.subscribe('follow.created', async (e) => void emitted.push(e));
  bus.subscribe('follow.removed', async (e) => void emitted.push(e));

  const event =
    opts.event === null
      ? null
      : ({
          id: 'evt_1',
          organizationId: 'org_1',
          venueId: 'venue_1',
          slug: 'rooftop-night',
          title: 'Rooftop Night',
          status: 'published',
          ...opts.event,
        } as Event);
  bus.subscribe(
    'event.published',
    createFollowerFanOutConsumer({
      events: { getById: async (id) => (event && event.id === id ? event : null) },
      follows,
      notifications,
    }),
  );

  let seq = 0;
  const deps = {
    config: { clock: { now: () => NOW }, ids: () => `id_${++seq}` },
    outbox: bus,
    repositories: {
      follows,
      socialNotifications: notifications,
      venues: { getById: async (id: string) => (id === 'venue_1' ? { id } : null) },
      organizations: { getById: async (id: string) => (id === 'org_1' ? { id } : null) },
    },
  } as unknown as ServiceDeps;

  const publish = (id = 'outbox_pub_1') =>
    bus.append(
      domainEvent({
        type: 'event.published',
        aggregateId: 'evt_1',
        organizationId: 'org_1',
        actorId: 'host_1',
        payload: { title: 'Rooftop Night' },
        id,
        occurredAt: NOW.getTime(),
      }),
    );

  return { service: new SocialService(deps), follows, notifications, emitted, publish };
}

describe('SocialService — follow graph (publisher side)', () => {
  it('follow is idempotent and publishes follow.created exactly once', async () => {
    const { service, emitted } = setup();
    const first = await service.follow(guest('u1'), 'venue', 'venue_1');
    const again = await service.follow(guest('u1'), 'venue', 'venue_1');

    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.follow.id).toBe(first.follow.id);
    expect(emitted.map((e) => e.type)).toEqual(['follow.created']);
    expect(emitted[0]?.payload).toEqual({
      followerId: 'u1',
      targetType: 'venue',
      targetId: 'venue_1',
    });
  });

  it('rejects an unknown target with not_found and emits nothing', async () => {
    const { service, emitted } = setup();
    await expect(service.follow(guest('u1'), 'host', 'org_missing')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(emitted).toHaveLength(0);
  });

  it('unfollow is idempotent and only publishes when an edge was removed', async () => {
    const { service, emitted } = setup();
    await service.unfollow(guest('u1'), 'venue', 'venue_1');
    expect(emitted).toHaveLength(0);

    await service.follow(guest('u1'), 'venue', 'venue_1');
    await service.unfollow(guest('u1'), 'venue', 'venue_1');
    await service.unfollow(guest('u1'), 'venue', 'venue_1');
    expect(emitted.map((e) => e.type)).toEqual(['follow.created', 'follow.removed']);
    expect(await service.followStatus('u1', 'venue', 'venue_1')).toEqual({
      following: false,
      followerCount: 0,
    });
  });

  it('followStatus reports own edge and total followers', async () => {
    const { service } = setup();
    await service.follow(guest('u1'), 'host', 'org_1');
    await service.follow(guest('u2'), 'host', 'org_1');
    expect(await service.followStatus('u1', 'host', 'org_1')).toEqual({
      following: true,
      followerCount: 2,
    });
    expect(await service.followStatus('u3', 'host', 'org_1')).toEqual({
      following: false,
      followerCount: 2,
    });
  });
});

describe('event.published → follower fan-out (subscriber side)', () => {
  it('notifies venue and host followers once each, venue reason winning', async () => {
    const { service, notifications, publish } = setup();
    await service.follow(guest('venue_fan'), 'venue', 'venue_1');
    await service.follow(guest('both'), 'venue', 'venue_1');
    await service.follow(guest('both'), 'host', 'org_1');
    await service.follow(guest('host_fan'), 'host', 'org_1');

    await publish();

    const all = [...notifications.entries.values()];
    expect(all.map((n) => n.userId).sort()).toEqual(['both', 'host_fan', 'venue_fan']);
    const both = all.find((n) => n.userId === 'both');
    expect(both).toMatchObject({
      type: 'event.new_from_followed',
      title: 'New event: Rooftop Night',
      body: 'A venue you follow just published a new event.',
      link: '/event/rooftop-night',
      subjectId: 'evt_1',
      createdAt: NOW.toISOString(),
      readAt: null,
    });
  });

  it('a re-publish (resumeSales / redelivery) never duplicates or un-reads', async () => {
    const { service, publish } = setup();
    await service.follow(guest('u1'), 'venue', 'venue_1');
    await publish('outbox_pub_1');
    await service.markAllRead('u1');

    await publish('outbox_pub_2');

    const page = await service.listNotifications('u1', { limit: 10 });
    expect(page.total).toBe(1);
    expect(page.items[0]?.readAt).toBe(NOW.toISOString());
    expect(await service.unreadCount('u1')).toBe(0);
  });

  it('notifies nobody when the event is no longer published', async () => {
    const { service, notifications, publish } = setup({ event: { status: 'cancelled' } });
    await service.follow(guest('u1'), 'venue', 'venue_1');
    await publish();
    expect(notifications.entries.size).toBe(0);
  });

  it('pages through more followers than one listFollowers page', async () => {
    const { service, notifications, publish } = setup();
    for (let i = 0; i < 230; i += 1) await service.follow(guest(`u${i}`), 'host', 'org_1');
    await publish();
    expect(notifications.entries.size).toBe(230);
  });
});

describe('SocialService — inbox reads', () => {
  it('markRead only touches the caller’s own unread rows', async () => {
    const { service, notifications, publish } = setup();
    await service.follow(guest('u1'), 'venue', 'venue_1');
    await service.follow(guest('u2'), 'venue', 'venue_1');
    await publish();
    const firstId = async (userId: string) => {
      const [row] = (await service.listNotifications(userId, { limit: 10 })).items;
      if (!row) throw new Error(`no notification for ${userId}`);
      return row.id;
    };
    const u1Id = await firstId('u1');
    const u2Id = await firstId('u2');

    expect(await service.markRead('u1', [u2Id, u1Id, u1Id])).toBe(1);
    expect(await service.markRead('u1', [u1Id])).toBe(0);
    expect(notifications.entries.get(u2Id)?.readAt).toBeNull();
    expect((await service.listNotifications('u1', { limit: 10, unreadOnly: true })).total).toBe(0);
  });
});
