import { NotFoundError, UnauthorizedError } from '../../domain/errors.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { Order } from '../../domain/models/order.js';
import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * One row of a partner's finance "Orders" table.
 *
 * This is an application-level **read model**, not a persisted entity — it
 * exists because the screen needs the event's name and the buyer display name
 * denormalized onto the row, and re-deriving either in the browser would mean
 * shipping the order plus an event directory to reconstruct one table. Same
 * precedent as `FinanceService`'s `BalanceSummary`: services own read-model
 * assembly, routes own serialization.
 *
 * Note what is NOT here: `contact.email` / `contact.phone`, the full pricing
 * breakdown, and `paymentIntentId`. The partner's money view doesn't need them,
 * and a money table is a bad place to widen PII. See
 * `financeOrderDtoSchema` in the contracts package for the wire shape.
 */
export interface FinanceOrderRow {
  readonly order: Order;
  readonly eventName: string;
  readonly ticketCount: number;
}

/**
 * ─── OrderService (Phase 4 PR3) ────────────────────────────────────────────────
 * Guest-facing reads — `GET /orders`, `GET /orders/:id`,
 * `GET /orders/:id/status` — plus the partner-scoped finance listing added once
 * Phase 6's ledger landed.
 *
 * HISTORY — the partner listing used to be absent on purpose. The original note
 * said it "needs a finance rollup that doesn't exist until Phase 6's ledger
 * lands", which is why it was not built. That condition is now met (the ledger
 * is the source of the partner's balance, and this list is the "where did that
 * balance come from" half of the same desk), so the listing exists. The old
 * rationale is kept because the constraint it names is still the right guard
 * rail: this is a *read* over the order aggregate, not a second place to
 * compute money.
 *
 * Ownership check is the same shape everywhere: a guest-facing order belongs to
 * the buyer who placed it (`order.userId`), and a mismatch is reported
 * identically to a missing order (404, never 403) — the IDOR-safe "no existence
 * oracle" rule already used by every other V2 route (ARCH:160). The partner
 * listing uses the *tenant* rule instead (`requireOrgAccess`), which is what
 * org-scoped routes use throughout.
 */
export class OrderService {
  constructor(private readonly deps: ServiceDeps) {}

  private assertOwned(order: Order | null, orderId: EntityId, actor: ActorContext): Order {
    if (!order || order.userId !== actor.userId) {
      throw new NotFoundError('Order', orderId);
    }
    return order;
  }

  async getById(orderId: EntityId, actor: ActorContext): Promise<Order> {
    const order = await this.deps.repositories.orders.getById(orderId);
    return this.assertOwned(order, orderId, actor);
  }

  async getStatus(orderId: EntityId, actor: ActorContext): Promise<Order> {
    return this.getById(orderId, actor);
  }

  async listForUser(actor: ActorContext, query: PaginationQuery): Promise<Page<Order>> {
    if (!actor.userId) throw new UnauthorizedError('A session is required to list orders');
    return this.deps.repositories.orders.listByUser(actor.userId, query);
  }

  /**
   * Orders belonging to one organization, newest first, with event names
   * resolved server-side.
   *
   * Tenant scoping is `requireOrgAccess` — this returns 403 for another
   * tenant's org id, unlike the guest path's 404. That asymmetry is
   * intentional: `requireOrgAccess` is comparing the *actor's own* tenant
   * against the path segment, so there is no resource-existence oracle to
   * withhold — the caller already knows which org they claimed to be.
   */
  async listForOrganization(
    organizationId: EntityId,
    actor: ActorContext,
    query: PaginationQuery,
  ): Promise<Page<FinanceOrderRow>> {
    requireOrgAccess(actor, organizationId);

    const page = await this.deps.repositories.orders.listByOrganization(organizationId, query);

    // Resolve each *distinct* event once, not once per order: a 20-row page of
    // a single event's sales would otherwise issue 20 identical reads.
    const eventIds = [...new Set(page.items.map((order) => order.eventId))];
    const names = new Map<EntityId, string>();
    await Promise.all(
      eventIds.map(async (eventId) => {
        const event = await this.deps.repositories.events.getById(eventId);
        // A deleted event must not blank the table row or 500 the page — fall
        // back to the id, which is still a truthful label.
        names.set(eventId, event?.title ?? eventId);
      }),
    );

    return {
      items: page.items.map((order) => ({
        order,
        eventName: names.get(order.eventId) ?? order.eventId,
        ticketCount: order.lines.reduce((sum, line) => sum + line.quantity, 0),
      })),
      total: page.total,
      nextCursor: page.nextCursor,
    };
  }
}
