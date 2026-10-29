import {
  ConflictError,
  DefiniteProviderFailureError,
  InvalidOperationError,
  NotFoundError,
  VersionConflictError,
} from '../../domain/errors.js';
import {
  freezeEntitlementForRefund,
  releaseEntitlementRefundLock,
  voidEntitlement,
} from '../../domain/models/entitlement.js';
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
  markRefundFailed,
  markRefundSettled,
  recordRefundProviderFact,
  rejectRefundRequest,
} from '../../domain/models/refund-request.js';
import { emit } from '../context.js';

import { FinancialPostingService } from './financial-posting-service.js';
import { ProviderPaymentService } from './provider-payment-service.js';

import type { EntityId } from '../../domain/identity.js';
import type { Entitlement } from '../../domain/models/entitlement.js';
import type { EventCoverAccount } from '../../domain/models/event-cover.js';
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
  ticketLines?: { tierId: EntityId; quantity: number }[];
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
    const ticketLines = command.ticketLines ?? [];
    const targetEntitlementIds: EntityId[] = [];
    if (ticketLines.length > 0) {
      const ordered = [...orderEntitlements].sort((left, right) => left.id.localeCompare(right.id));
      const seenTiers = new Set<EntityId>();
      for (const line of ticketLines) {
        if (seenTiers.has(line.tierId)) {
          throw new InvalidOperationError(`Refund tier ${line.tierId} was selected twice`);
        }
        seenTiers.add(line.tierId);
        const purchased = order.lines.find((item) => item.tierId === line.tierId)?.quantity ?? 0;
        if (
          !Number.isSafeInteger(line.quantity) ||
          line.quantity <= 0 ||
          line.quantity > purchased
        ) {
          throw new InvalidOperationError(`Invalid refund quantity for tier ${line.tierId}`);
        }
        const eligible = ordered.filter(
          (entitlement) => entitlement.tierId === line.tierId && entitlement.status !== 'void',
        );
        if (eligible.length < line.quantity) {
          throw new InvalidOperationError(`Not enough refundable tickets for tier ${line.tierId}`);
        }
        targetEntitlementIds.push(
          ...eligible.slice(0, line.quantity).map((entitlement) => entitlement.id),
        );
      }
    }
    const coverAccounts = await this.getCoverAccounts(order, orderEntitlements);
    await this.assertCoverRefundScope(
      order,
      command.amountPaise,
      ticketLines.length > 0,
      coverAccounts,
    );
    const hasRedeemedEntitlement = orderEntitlements.some(
      (entitlement) =>
        entitlement.status === 'redeemed' ||
        entitlement.ticketAddons?.some((addon) => addon.status === 'redeemed'),
    );

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
      scope: ticketLines.length > 0 ? 'ticket_lines' : 'amount_only',
      ticketLines,
      targetEntitlementIds,
      hasRedeemedEntitlement,
      thresholds,
      now,
    });

    const lockedOrder = lockOrderForRefund(order, now);
    await this.orders.save(lockedOrder);
    await this.refundRequests.save(request);
    await this.ensureSelectedTicketsFrozen(request, now);
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
    await this.releaseSelectedTickets(request, now);

    await emit(
      this.deps,
      {
        userId: admin.id,
        organizationId: order.organizationId,
        role: 'owner',
        capabilities: [],
      },
      request.id,
      'finance.refund.finalized',
      { refundRequestId: request.id, orderId: order.id, status: 'rejected' },
    );

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
    // Recheck and freeze at execution: an approved request may predate delayed
    // cover issuance, and a Venue redemption must not race provider movement.
    const orderEntitlements = await this.entitlements.getByOrderId(order.id);
    const coverAccounts = await this.getCoverAccounts(order, orderEntitlements);
    await this.assertCoverRefundScope(
      order,
      request.amountPaise,
      request.scope === 'ticket_lines',
      coverAccounts,
      request.id,
    );
    const coverAccountsToFreeze = coverAccounts.filter((account) => account.status !== 'refunded');
    if (coverAccountsToFreeze.length > 0) {
      await this.deps.repositories.eventCoverAccounts.freezeForRefund(
        coverAccountsToFreeze.map((account) => account.entitlementId),
        request.id,
        this.deps.config.clock.now(),
      );
    }

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
        if (winner.status === 'rejected' || winner.status === 'failed') {
          await this.releaseCoverRefundFreeze(order.id, request.id, this.deps.config.clock.now());
        }
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

    // This convergence step runs before every provider call. If request
    // creation crashed midway through freezing a multi-ticket selection, the
    // retry finishes the exact persisted set before money can move.
    await this.ensureSelectedTicketsFrozen(request, now);

    if (!request.providerRefundId) {
      let response;
      try {
        response = await this.deps.paymentProvider.refundPayment({
          paymentId: order.paymentId,
          amountPaise: request.amountPaise,
          idempotencyKey: request.executionIdempotencyKey,
        });
      } catch (error) {
        if (error instanceof DefiniteProviderFailureError) {
          const failed = markRefundFailed(
            request,
            'Provider definitively rejected the refund',
            now,
          );
          await this.refundRequests.save(failed);
          await this.releaseSelectedTickets(failed, now);
          await this.releaseCoverRefundFreeze(order.id, request.id, now);
          const restored = restoreOrderAfterRefundFailure(order, now);
          await this.orders.save(restored);
          await emit(
            this.deps,
            {
              userId: admin.id,
              organizationId: order.organizationId,
              role: 'owner',
              capabilities: [],
            },
            request.id,
            'finance.refund.finalized',
            { refundRequestId: request.id, orderId: order.id, status: 'failed' },
          );
          return { request: failed, order: restored };
        }
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
      if (response.status === 'failed') {
        const failed = markRefundFailed(request, 'Provider definitively rejected the refund', now);
        await this.refundRequests.save(failed);
        await this.releaseSelectedTickets(failed, now);
        await this.releaseCoverRefundFreeze(order.id, request.id, now);
        const restored = restoreOrderAfterRefundFailure(order, now);
        await this.orders.save(restored);
        await emit(
          this.deps,
          {
            userId: admin.id,
            organizationId: order.organizationId,
            role: 'owner',
            capabilities: [],
          },
          request.id,
          'finance.refund.finalized',
          { refundRequestId: request.id, orderId: order.id, status: 'failed' },
        );
        return { request: failed, order: restored };
      }
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

    for (const account of coverAccounts) {
      await this.deps.repositories.eventCoverAccounts.refundUnused(account.id, {
        operationId: request.id,
        refundRequestId: request.id,
        actorUserId: admin.id,
        now,
      });
    }

    const refundedOrder = applyOrderRefund(order, request.amountPaise, now, request.id);
    if (refundedOrder !== order) await this.orders.save(refundedOrder);
    if (refundedOrder.status === 'refunded' || request.scope === 'ticket_lines') {
      const targets =
        refundedOrder.status === 'refunded'
          ? await this.entitlements.getByOrderId(order.id)
          : await Promise.all(
              request.targetEntitlementIds.map((id) => this.entitlements.getById(id)),
            );
      for (const entitlement of targets) {
        if (!entitlement || entitlement.orderId !== order.id) {
          throw new InvalidOperationError('Refund ticket selection no longer matches the order');
        }
        if (refundedOrder.status === 'refunded' && entitlement.upgradeFromEntitlementId) {
          await this.entitlements.restoreForUpgradeRefund({
            sourceEntitlementId: entitlement.upgradeFromEntitlementId,
            replacementEntitlementId: entitlement.id,
            refundRequestId: request.id,
            now,
          });
          continue;
        }
        const voided = voidEntitlement(entitlement, now, request.id);
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

  private async getCoverAccounts(
    order: Order,
    entitlements: readonly Entitlement[],
  ): Promise<EventCoverAccount[]> {
    const coverAccounts = await Promise.all(
      entitlements.map((entitlement) =>
        this.deps.repositories.eventCoverAccounts.getByEntitlement(entitlement.id),
      ),
    );
    const linked = coverAccounts.filter(
      (account): account is EventCoverAccount => account !== null,
    );
    const expectedCoverCount = order.lines.reduce((count, line) => {
      if ((line.coverUnitPricePaise ?? 0) <= 0) return count;
      const attendeeUnits = line.admissionMode === 'per_person' ? (line.guestCount ?? 1) : 1;
      return count + line.quantity * attendeeUnits;
    }, 0);
    if (linked.length !== expectedCoverCount) {
      throw new InvalidOperationError(
        'Cover refund is unavailable until every purchased cover entitlement has its ledger account',
      );
    }
    for (const account of linked) {
      const entitlement = entitlements.find((item) => item.id === account.entitlementId);
      const line = order.lines.find((item) => item.tierId === entitlement?.tierId);
      if (
        !entitlement ||
        account.orderId !== order.id ||
        account.eventId !== order.eventId ||
        (line?.coverUnitPricePaise ?? 0) !== account.issuedPaise
      ) {
        throw new InvalidOperationError('Cover account provenance does not match the refund order');
      }
    }
    return linked;
  }

  private async assertCoverRefundScope(
    order: Order,
    amountPaise: number,
    ticketLines: boolean,
    accounts: readonly EventCoverAccount[],
    refundRequestId?: EntityId,
  ): Promise<void> {
    if (accounts.length === 0) return;
    const eligible =
      !ticketLines &&
      order.refundedPaise === 0 &&
      amountPaise === refundableBalance(order) &&
      (await Promise.all(
        accounts.map(async (account) => {
          const alreadyRefunded =
            refundRequestId !== undefined &&
            account.status === 'refunded' &&
            account.refundedPaise === account.issuedPaise &&
            account.remainingPaise === 0 &&
            (await this.deps.repositories.eventCoverAccounts.listEntries(account.id)).some(
              (entry) => entry.type === 'refund' && entry.operationId === refundRequestId,
            );
          return (
            account.refundPolicy === 'unused_full_before_redemption' &&
            (alreadyRefunded ||
              (account.remainingPaise === account.issuedPaise &&
                account.reservedPaise === 0 &&
                account.redeemedPaise === 0 &&
                account.refundedPaise === 0 &&
                (account.status === 'active' ||
                  (account.status === 'frozen' && account.refundRequestId === refundRequestId))))
          );
        }),
      ).then((results) => results.every(Boolean)));
    if (!eligible) {
      throw new InvalidOperationError(
        'Event cover refunds require the full unused balance, an eligible saved Venue policy, and a full-order refund',
      );
    }
  }

  private async releaseCoverRefundFreeze(orderId: EntityId, requestId: EntityId, now: Date) {
    const orderEntitlements = await this.entitlements.getByOrderId(orderId);
    await this.deps.repositories.eventCoverAccounts.releaseRefundFreeze(
      orderEntitlements.map((entitlement) => entitlement.id),
      requestId,
      now,
    );
  }

  private async ensureSelectedTicketsFrozen(request: AdminRefundRequest, now: Date): Promise<void> {
    if (request.scope !== 'ticket_lines') return;
    for (const entitlementId of request.targetEntitlementIds) {
      const entitlement = await this.entitlements.getById(entitlementId);
      if (!entitlement || entitlement.orderId !== request.orderId) {
        throw new InvalidOperationError('Refund ticket selection no longer matches the order');
      }
      const frozen = freezeEntitlementForRefund(entitlement, request.id, now);
      if (frozen !== entitlement) await this.entitlements.save(frozen);
    }
  }

  private async releaseSelectedTickets(request: AdminRefundRequest, now: Date): Promise<void> {
    if (request.scope !== 'ticket_lines') return;
    for (const entitlementId of request.targetEntitlementIds) {
      const entitlement = await this.entitlements.getById(entitlementId);
      if (!entitlement || entitlement.orderId !== request.orderId) continue;
      const released = releaseEntitlementRefundLock(entitlement, request.id, now);
      if (released !== entitlement) await this.entitlements.save(released);
    }
  }
}
