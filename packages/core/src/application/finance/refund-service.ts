import { InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import {
  lockOrderForRefund,
  refundableBalance,
  restoreOrderAfterRefundFailure,
} from '../../domain/models/order.js';
import {
  approveRefundRequest,
  createRefundRequest,
  rejectRefundRequest,
} from '../../domain/models/refund-request.js';

import type { EntityId } from '../../domain/identity.js';
import type { Order } from '../../domain/models/order.js';
import type { AdminRefundRequest } from '../../domain/models/refund-request.js';
import type { AuditRequestMeta } from '../../domain/ports/audit.js';
import type { PaginationQuery } from '../../domain/ports/repositories.js';
import type { AdminAuthorityService } from '../admin/admin-authority-service.js';
import type { ServiceDeps } from '../context.js';

/**
 * ─── Admin refund service (Phase 6 admin) ────────────────────────────────────
 *
 * The real money logic v1 had in its API gateway, not its admin console —
 * see `refund-request.ts`'s header comment for why that split matters.
 *
 * This service, not `admin-authority`'s propose→resolve, owns the
 * N-approver accumulator: `AdminRefundRequest.approversRequired` is fixed
 * from the amount tier at creation. `FINANCIAL_REFUND` is TIER2 in
 * `admin-authority` purely as the *initiation* gate (who may request or
 * approve a refund at all) — it is never proposed/resolved as a TIER3
 * dual-control action.
 *
 * Nothing here settles automatically. A request reaching `approved` (whether
 * via the zero-approver tier or the last required sign-off) is as far as
 * this service goes — no payment-provider call, no order mutation beyond
 * the lock taken at request time. Actual settlement is a deliberately
 * separate, not-yet-built step (product decision pending); wiring it back
 * in means adding an explicit settle action, not restoring the old
 * auto-settle branches below.
 */

export interface RequestRefundCommand {
  orderId: EntityId;
  amountPaise: number;
  reason: string;
}

export class RefundService {
  constructor(
    private deps: ServiceDeps,
    private authority: AdminAuthorityService,
  ) {}

  private get orders() {
    return this.deps.repositories.orders;
  }

  private get entitlements() {
    return this.deps.repositories.entitlements;
  }

  private get refundRequests() {
    return this.deps.repositories.refundRequests;
  }

  async requestRefund(
    adminUserId: EntityId,
    command: RequestRefundCommand,
    meta?: AuditRequestMeta,
  ): Promise<{ request: AdminRefundRequest; order: Order }> {
    const admin = await this.authority.authorize(adminUserId, 'FINANCIAL_REFUND');
    const order = await this.requireOrder(command.orderId);
    if (order.status !== 'paid') {
      throw new InvalidOperationError(`Order ${order.id} is not paid — nothing to refund`);
    }
    const remaining = refundableBalance(order);
    if (command.amountPaise > remaining) {
      throw new InvalidOperationError(
        `Refund of ${command.amountPaise} exceeds order ${order.id}'s refundable balance of ${remaining}`,
      );
    }

    const orderEntitlements = await this.entitlements.getByOrderId(order.id);
    const hasRedeemedEntitlement = orderEntitlements.some((e) => e.status === 'redeemed');

    const now = this.deps.config.clock.now();
    const platformSettings = await this.deps.repositories.platformSettings.get();
    const thresholds = {
      singleApproverCeilingPaise: platformSettings.refundSingleApproverThresholdPaise,
      dualApproverCeilingPaise: platformSettings.refundDualApproverThresholdPaise,
    };
    const request = createRefundRequest({
      id: this.deps.config.ids(),
      orderId: order.id,
      organizationId: order.organizationId,
      amountPaise: command.amountPaise,
      requestedBy: admin.id,
      reason: command.reason,
      hasRedeemedEntitlement,
      thresholds,
      now,
    });

    const lockedOrder = lockOrderForRefund(order, now);
    await this.orders.save(lockedOrder);
    await this.refundRequests.save(request);
    await this.authority.record(admin, {
      action: 'FINANCIAL_REFUND.request',
      targetType: 'refund_request',
      targetId: request.id,
      before: { orderStatus: order.status },
      after: { orderStatus: lockedOrder.status, requestStatus: request.status },
      reason: request.reason,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    this.deps.logger.info('refund.requested', {
      requestId: request.id,
      orderId: order.id,
      amountPaise: command.amountPaise,
      approversRequired: request.approversRequired,
    });

    return { request, order: lockedOrder };
  }

  async approveRefund(
    adminUserId: EntityId,
    refundRequestId: EntityId,
    meta?: AuditRequestMeta,
  ): Promise<{ request: AdminRefundRequest; order: Order }> {
    const admin = await this.authority.authorize(adminUserId, 'FINANCIAL_REFUND');
    const request = await this.requireRefundRequest(refundRequestId);
    const now = this.deps.config.clock.now();
    const approved = approveRefundRequest(request, admin.id, now);
    await this.refundRequests.save(approved);
    await this.authority.record(admin, {
      action: 'FINANCIAL_REFUND.approve',
      targetType: 'refund_request',
      targetId: request.id,
      before: { status: request.status, approvals: request.approvals.length },
      after: { status: approved.status, approvals: approved.approvals.length },
      reason: null,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });

    const order = await this.requireOrder(request.orderId);
    return { request: approved, order };
  }

  async rejectRefund(
    adminUserId: EntityId,
    refundRequestId: EntityId,
    reason: string,
    meta?: AuditRequestMeta,
  ): Promise<{ request: AdminRefundRequest; order: Order }> {
    const admin = await this.authority.authorize(adminUserId, 'FINANCIAL_REFUND');
    const request = await this.requireRefundRequest(refundRequestId);
    const now = this.deps.config.clock.now();
    const rejected = rejectRefundRequest(request, admin.id, reason, now);
    await this.refundRequests.save(rejected);

    // The order was locked when the request was created — restore it via the
    // dedicated function, never a value chosen here. This is the exact fix
    // for v1's admin console hardcoding the restore status on rejection.
    const order = await this.requireOrder(request.orderId);
    const restored = restoreOrderAfterRefundFailure(order, now);
    await this.orders.save(restored);

    await this.authority.record(admin, {
      action: 'FINANCIAL_REFUND.reject',
      targetType: 'refund_request',
      targetId: request.id,
      before: { status: request.status, orderStatus: order.status },
      after: { status: rejected.status, orderStatus: restored.status },
      reason,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    this.deps.logger.info('refund.rejected', { requestId: request.id, orderId: order.id });
    return { request: rejected, order: restored };
  }

  async listRefunds(
    adminUserId: EntityId,
    status: AdminRefundRequest['status'] | null,
    query: PaginationQuery,
  ) {
    await this.authority.requireAdmin(adminUserId);
    return this.refundRequests.listByStatus(status, query);
  }

  async getRefund(adminUserId: EntityId, refundRequestId: EntityId): Promise<AdminRefundRequest> {
    await this.authority.requireAdmin(adminUserId);
    return this.requireRefundRequest(refundRequestId);
  }

  private async requireOrder(orderId: EntityId): Promise<Order> {
    const order = await this.orders.getById(orderId);
    if (!order) throw new NotFoundError('order', orderId);
    return order;
  }

  private async requireRefundRequest(id: EntityId): Promise<AdminRefundRequest> {
    const request = await this.refundRequests.getById(id);
    if (!request) throw new NotFoundError('refund_request', id);
    return request;
  }
}
