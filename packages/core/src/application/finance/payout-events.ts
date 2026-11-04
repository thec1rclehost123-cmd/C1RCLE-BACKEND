import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';

import type { EntityId } from '../../domain/identity.js';
import type { Payout } from '../../domain/models/payout.js';
import type { OutboxWriter } from '../../domain/ports/outbox.js';

export async function appendPayoutStatusEvent(
  outbox: OutboxWriter | undefined,
  payout: Payout,
  actorId: EntityId,
  occurredAt: Date,
): Promise<void> {
  if (!outbox) return;
  await outbox.append(
    domainEvent({
      id: deterministicDomainEventId(
        'finance.payout.status_changed',
        payout.id,
        String(payout.version),
      ),
      type: 'finance.payout.status_changed',
      aggregateId: payout.id,
      organizationId: payout.organizationId,
      actorId,
      payload: {
        payoutId: payout.id,
        organizationId: payout.organizationId,
        status: payout.status,
        version: payout.version,
        amountPaise: payout.amount,
      },
      occurredAt: occurredAt.getTime(),
    }),
  );
}
