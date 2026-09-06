import { NotFoundError, UnauthorizedError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { Entitlement } from '../../domain/models/entitlement.js';
import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * ─── TicketService (Phase 4 PR3) ───────────────────────────────────────────────
 * Guest-facing reads only — `GET /tickets/:id`, `GET /wallet/tickets`.
 * Transfer / claim / cancel-transfer are NOT implemented here: the committed
 * `Entitlement` model (`domain/models/entitlement.ts`) has no transfer state
 * at all (`EntitlementStatus` is only `valid | redeemed | void`), so building
 * those three routes now would mean inventing unreviewed ticket-ownership
 * semantics (a claim-token scheme, whether a partially-scanned couple ticket
 * is transferable) without a design decision behind them — the same "don't
 * guess a contract" rule the master prompt applies to the frontend applies
 * here too. See the PR3 handoff note for the open questions.
 *
 * Ownership check mirrors `OrderService`: a ticket belongs to the guest it
 * was issued to (`entitlement.userId`), and a mismatch reports as 404, never
 * 403 (IDOR-safe, no existence oracle).
 */
export class TicketService {
  constructor(private readonly deps: ServiceDeps) {}

  async getById(ticketId: EntityId, actor: ActorContext): Promise<Entitlement> {
    const entitlement = await this.deps.repositories.entitlements.getById(ticketId);
    if (!entitlement || entitlement.userId !== actor.userId) {
      throw new NotFoundError('Ticket', ticketId);
    }
    return entitlement;
  }

  async listForUser(actor: ActorContext, query: PaginationQuery): Promise<Page<Entitlement>> {
    if (!actor.userId) throw new UnauthorizedError('A session is required to list tickets');
    return this.deps.repositories.entitlements.listByUser(actor.userId, query);
  }
}
