import { UnauthorizedError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { EventCoverEntryType, EventCoverStatus } from '../../domain/models/event-cover.js';
import type { ActorContext, ServiceDeps } from '../context.js';

export interface EventCoverWalletItem {
  entitlementId: EntityId;
  eventId: EntityId;
  status: EventCoverStatus;
  issuedPaise: number;
  remainingPaise: number;
  reservedPaise: number;
  redeemedPaise: number;
  refundedPaise: number;
  policyVersion: string;
  history: { type: EventCoverEntryType; amountPaise: number; createdAt: string }[];
}

/** Caller-scoped projection of event-cover accounts held by the current Guest. */
export class EventCoverWalletService {
  constructor(private readonly deps: ServiceDeps) {}

  async listForGuest(actor: ActorContext): Promise<EventCoverWalletItem[]> {
    if (!actor.userId) throw new UnauthorizedError('A session is required to read event cover');
    const entitlements = await this.deps.repositories.entitlements.listByHolder(actor.userId, {
      limit: 100,
      cursor: null,
    });
    const items = await Promise.all(
      entitlements.items.map(async (entitlement) => {
        const account = await this.deps.repositories.eventCoverAccounts.getByEntitlement(
          entitlement.id,
        );
        if (!account) return null;
        const history = (
          await this.deps.repositories.eventCoverAccounts.listEntries(account.id)
        ).map((entry) => ({
          type: entry.type,
          amountPaise: entry.amountPaise,
          createdAt: entry.createdAt,
        }));
        return {
          entitlementId: entitlement.id,
          eventId: entitlement.eventId,
          status: account.status,
          issuedPaise: account.issuedPaise,
          remainingPaise: account.remainingPaise,
          reservedPaise: account.reservedPaise,
          redeemedPaise: account.redeemedPaise,
          refundedPaise: account.refundedPaise,
          policyVersion: account.policyVersion,
          history,
        };
      }),
    );
    return items.filter((item): item is EventCoverWalletItem => item !== null);
  }
}
