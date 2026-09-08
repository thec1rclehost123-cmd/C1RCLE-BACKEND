import { NotFoundError, UnauthorizedError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { Order } from '../../domain/models/order.js';
import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * ─── OrderService (Phase 4 PR3) ────────────────────────────────────────────────
 * Guest-facing reads only — `GET /orders`, `GET /orders/:id`,
 * `GET /orders/:id/status`. No partner/organization-scoped listing here: that
 * needs a finance rollup (revenue, per-event totals) that doesn't exist until
 * Phase 6's ledger lands (ROADMAP.md), so building it now would be a guessed
 * contract against a slice that isn't designed yet (master prompt §27).
 *
 * Ownership check is the same shape everywhere: an order belongs to the buyer
 * who placed it (`order.userId`), and a mismatch is reported identically to a
 * missing order (404, never 403) — the IDOR-safe "no existence oracle" rule
 * already used by every other V2 route (ARCH:160).
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
}
