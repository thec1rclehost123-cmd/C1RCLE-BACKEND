import { noopLogger } from '@c1rcle/core';
import { createTransactionalEmailConsumer, InProcessEventBus } from '@c1rcle/core/application';
import { domainEvent } from '@c1rcle/core/domain';
import { MemoryEmailDeliveryRepository, MemoryOutboxStore } from '@c1rcle/core/infrastructure';
import { describe, expect, it, vi } from 'vitest';

import type { ServiceDeps } from '@c1rcle/core/application';
import type { TransactionalEmail } from '@c1rcle/core/domain';

import {
  subscribeTransactionalEmailConsumer,
  TRANSACTIONAL_EMAIL_EVENT_TYPES,
} from './transactional-email-wiring.js';

describe('transactional email subscriber wiring', () => {
  it('registers all V1 email producers exactly once and excludes waitlist email', () => {
    const subscribe = vi.fn();
    const consumer = vi.fn(async () => {});
    subscribeTransactionalEmailConsumer({ subscribe }, consumer);

    const registered = subscribe.mock.calls.map(([type]) => type);
    expect(registered).toEqual(TRANSACTIONAL_EMAIL_EVENT_TYPES);
    expect(new Set(registered).size).toBe(registered.length);
    expect(registered).toContain('partner.onboarding.email_requested');
    expect(registered).not.toContain('promoter.onboarding.submitted');
    expect(registered).not.toContain('promoter.onboarding.approved');
    expect(registered).not.toContain('promoter.onboarding.rejected');
    expect(registered).not.toContain('waitlist.offered');
    expect(registered).not.toContain('waitlist.expired');
    for (const type of [
      'promoter.assignment.invited',
      'promoter.assignment.accepted',
      'promoter.assignment.rejected',
      'promoter.assignment.revoked',
      'promoter.assignment.expired',
      'promoter.assignments.status_changed',
      'event-cover.refunded',
      'ticket.addon.redeemed',
      'event.material_change.refund_requested',
    ]) {
      expect(registered).toContain(type);
    }
    for (const [, handler] of subscribe.mock.calls) expect(handler).toBe(consumer);
  });

  it('carries a subscribed producer event through the outbox into a durable email intent', async () => {
    const now = new Date('2026-11-05T12:00:00.000Z');
    const emailDeliveries = new MemoryEmailDeliveryRepository();
    const sendTransactionalEmail = vi.fn(async (_message: TransactionalEmail) => ({
      providerMessageId: 'synthetic-provider-id',
    }));
    const deps = {
      config: { clock: { now: () => now } },
      logger: noopLogger,
      emailDeliveries,
      emailSender: { name: 'synthetic', sendTransactionalEmail },
      userDirectory: { getEmailById: async () => 'owner@synthetic.test' },
      repositories: {
        organizations: {
          getById: async (id: string) => ({ id, ownerId: 'owner-synthetic' }),
        },
      },
    };
    const bus = new InProcessEventBus(new MemoryOutboxStore(), { now: () => now.getTime() });
    subscribeTransactionalEmailConsumer(
      bus,
      createTransactionalEmailConsumer(deps as unknown as ServiceDeps),
    );

    await bus.append(
      domainEvent({
        id: 'promoter-assignment-event-synthetic',
        type: 'promoter.assignment.invited',
        aggregateId: 'assignment-synthetic',
        organizationId: 'event-org-synthetic',
        actorId: 'host-synthetic',
        occurredAt: now.getTime(),
        payload: {
          assignmentId: 'assignment-synthetic',
          eventId: 'event-synthetic',
          promoterId: 'promoter-org-synthetic',
          eventTitle: 'Synthetic Event',
        },
      }),
    );

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(sendTransactionalEmail.mock.calls[0]?.[0]).toMatchObject({
      to: 'owner@synthetic.test',
      templateType: 'promoter_assignment_status',
      idempotencyKey: 'promoter-assignment-email:assignment-synthetic:promoter.assignment.invited',
    });
    expect([...emailDeliveries.records.values()]).toMatchObject([
      { kind: 'promoter_assignment_status', status: 'sent' },
    ]);
  });
});
