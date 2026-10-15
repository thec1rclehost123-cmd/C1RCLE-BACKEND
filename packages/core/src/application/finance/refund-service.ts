import {
  ConflictError,
  InvalidOperationError,
  NotFoundError,
  VersionConflictError,
} from '../../domain/errors.js';
import { voidEntitlement } from '../../domain/models/entitlement.js';
import {
  applyOrderRefund,
  lockOrderForRefund,
  refundableBalance,
  restoreOrderAfterRefundFailure,
} from '../../domain/models/order.js';
import {
  approveRefundRequest,
  beginRefundExecution,
  createRefundRequest,
  markRefundExecutionUncertain,
  markRefundSettled,
  recordRefundProviderFact,
  rejectRefundRequest,
} from '../../domain/models/refund-request.js';
import { emit } from '../context.js';

import { FinancialPostingService } from './financial-posting-service.js';
import { ProviderPaymentService } from './provider-payment-service.js';

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
 * Approval and execution remain separate actions. Reaching `approved` never
 * moves money by itself; an authorized operator must explicitly execute the
 * request. Execution persists the provider fact before applying journal,
 * order, and entitlement effects so retries can converge without duplicating
 * the provider refund.
 */

export interface RequestRefundCommand {
  orderId: EntityId;
  amountPaise: number;
  reason: string;
}

export class RefundService {
  private readonly posting: FinancialPostingService;
  private readonly providerPayments: ProviderPaymentService;

  constructor(
    private deps: ServiceDeps,
    private authority: AdminAuthorityService,
  ) {
    this.posting = new FinancialPostingService(deps.repositories.financialJournals);
    this.providerPayments = new ProviderPaymentService(deps);
  }

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

  /**
   * Executes an approved refund and converges every internal effect from the
   * persisted provider fact. A deterministic provider key and the `executing`
   * claim prevent duplicate money movement; a retry after a crash resumes the
   * journal/order/ticket steps without calling the provider again once its id
   * is stored.
   */
  async executeRefund(
    adminUserId: EntityId,
    refundRequestId: EntityId,
    meta?: AuditRequestMeta,
  ): Promise<{ request: AdminRefundRequest; order: Order }> {
    const admin = await this.authority.authorize(adminUserId, 'FINANCIAL_REFUND');
    let request = await this.requireRefundRequest(refundRequestId);
    let order = await this.requireOrder(request.orderId);
    if (request.status === 'settled') return { request, order };

    const now = this.deps.config.clock.now();
    if (request.status === 'executing' && request.providerRefundId === null) {
      throw new ConflictError(
        request.failureReason
          ? 'Refund provider result requires reconciliation before retry'
          : 'Refund execution is already in progress or requires reconciliation',
      );
    }
    if (request.status === 'approved' || request.status === 'failed') {
      const claimed = beginRefundExecution(request, now);
      try {
        await this.refundRequests.save(claimed);
        request = claimed;
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
        const winner = await this.requireRefundRequest(refundRequestId);
        if (winner.status === 'settled') return { request: winner, order };
        throw new ConflictError('Refund execution is already in progress');
      }
    } else if (request.status !== 'executing') {
      throw new InvalidOperationError(`Refund request is ${request.status}, not executable`);
    }

    const orderAlreadyApplied = order.appliedRefundRequestIds.includes(request.id);
    if (order.status === 'paid' && !orderAlreadyApplied) {
      order = lockOrderForRefund(order, now);
      await this.orders.save(order);
    }
    if (order.status !== 'refund_requested' && !orderAlreadyApplied) {
      throw new InvalidOperationError(`Order ${order.id} is not locked for refund`);
    }
    if (!order.paymentId) throw new InvalidOperationError('Order has no provider payment id');

    if (!request.providerRefundId) {
      let response;
      try {
        response = await this.deps.paymentProvider.refundPayment({
          paymentId: order.paymentId,
          amountPaise: request.amountPaise,
          idempotencyKey: request.executionIdempotencyKey,
        });
      } catch (error) {
        // A network/timeout error can occur after the provider accepted the
        // refund. Never unlock or retry automatically: doing so could move
        // money twice. Reconciliation/webhook evidence must resolve it.
        const detail = error instanceof Error ? error.message : 'unknown provider error';
        request = markRefundExecutionUncertain(request, detail, now);
        await this.refundRequests.save(request);
        throw new ConflictError('Refund provider result is uncertain; order remains locked');
      }
      // Persist provider success outside the provider-call catch. If this save
      // fails, retaining the execution lock is safer than falsely marking the
      // refund failed and reopening an order after money may have moved.
      request = recordRefundProviderFact(request, response.id, response.status, now);
      await this.refundRequests.save(request);
    }
    if (request.providerStatus !== 'processed' && request.providerRefundId) {
      const providerPayment = await this.deps.repositories.providerPayments.findByPaymentId(
        order.paymentId,
      );
      if (providerPayment?.refunds[request.providerRefundId] === request.amountPaise) {
        request = recordRefundProviderFact(request, request.providerRefundId, 'processed', now);
        await this.refundRequests.save(request);
      }
    }
    if (request.providerStatus !== 'processed' || !request.providerRefundId) {
      throw new ConflictError(
        `Provider refund is ${request.providerStatus ?? 'pending'}; awaiting authoritative completion`,
      );
    }

    await this.providerPayments.recordEvent({
      type: 'refund_processed',
      paymentId: order.paymentId,
      refundId: request.providerRefundId,
      amountPaise: request.amountPaise,
      currency: order.currency,
    });
    await this.posting.postRefund({
      organizationId: order.organizationId,
      orderId: order.id,
      eventId: order.eventId,
      paymentId: order.paymentId,
      refundRequestId: request.id,
      providerRefundId: request.providerRefundId,
      amountPaise: request.amountPaise,
      previouslyRefundedPaise: orderAlreadyApplied
        ? order.refundedPaise - request.amountPaise
        : order.refundedPaise,
      postedAt: now,
    });

    const refundedOrder = applyOrderRefund(order, request.amountPaise, now, request.id);
    if (refundedOrder !== order) await this.orders.save(refundedOrder);
    if (refundedOrder.status === 'refunded') {
      for (const entitlement of await this.entitlements.getByOrderId(order.id)) {
        const voided = voidEntitlement(entitlement, now);
        if (voided !== entitlement) await this.entitlements.save(voided);
      }
    }
    const settled = markRefundSettled(request, request.providerRefundId, now);
    await this.refundRequests.save(settled);
    await emit(
      this.deps,
      {
        userId: admin.id,
        organizationId: order.organizationId,
        role: 'owner',
        capabilities: [],
      },
      request.id,
      'finance.refund.settled',
      {
        refundRequestId: request.id,
        orderId: order.id,
        amountPaise: request.amountPaise,
        providerRefundId: request.providerRefundId,
      },
    );
    await this.authority.record(admin, {
      action: 'FINANCIAL_REFUND.execute',
      targetType: 'refund_request',
      targetId: request.id,
      before: { status: request.status, orderStatus: order.status },
      after: { status: settled.status, orderStatus: refundedOrder.status },
      reason: request.reason,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return { request: settled, order: refundedOrder };
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
