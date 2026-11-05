import { createHash } from 'node:crypto';

import {
  ConflictError,
  DefiniteProviderFailureError,
  InvalidOperationError,
  NotFoundError,
  VersionConflictError,
} from '../../domain/errors.js';
import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import { newVersionedEntity } from '../../domain/identity.js';
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
import { quoteOriginalRefund } from '../../domain/models/purchase-refund-snapshot.js';
import {
  createReconciliationRun,
  completeReconciliationRun,
} from '../../domain/models/reconciliation.js';
import {
  approveRefundRequest,
  beginRefundExecution,
  createRefundRequest,
  markRefundExecutionUncertain,
  markRefundFailed,
  markRefundSettled,
  recordRefundProviderFact,
  rejectRefundRequest,
  rejectUnexecutedRefundForPolicyChange,
} from '../../domain/models/refund-request.js';
import { selectRefundTargets } from '../../domain/models/refund-targets.js';
import { CheckoutService } from '../checkout/checkout-service.js';
import { emit } from '../context.js';

import { FinancialPostingService } from './financial-posting-service.js';
import { ProviderPaymentService } from './provider-payment-service.js';
import { requestOriginalPolicyRemedy } from './refund-policy-remedy.js';

import type { EntityId } from '../../domain/identity.js';
import type { PlatformAdmin } from '../../domain/models/admin-authority.js';
import type { Entitlement } from '../../domain/models/entitlement.js';
import type { EventCoverAccount } from '../../domain/models/event-cover.js';
import type { Order } from '../../domain/models/order.js';
import type { RefundCause } from '../../domain/models/purchase-refund-snapshot.js';
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
  amountPaise?: number;
  refundCause?: RefundCause;
  /** Passed only from the validated server-side command header. */
  intakeKey?: string;
  reason: string;
  ticketLines?: { tierId: EntityId; quantity: number }[];
  targetEntitlementIds?: EntityId[];
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

  /** Read-only recovery when response-cache persistence failed after canonical intake committed. */
  async replayIntake(
    adminUserId: EntityId,
    command: RequestRefundCommand,
  ): Promise<{ request: AdminRefundRequest; order: Order } | null> {
    const admin = await this.authority.authorize(adminUserId, 'FINANCIAL_REFUND');
    if (!command.intakeKey) return null;
    const request = await this.refundRequests.getById(this.intakeId(admin.id, command.intakeKey));
    if (!request) return null;
    if (
      request.requestedBy !== admin.id ||
      request.orderId !== command.orderId ||
      request.intakeFingerprint !== this.intakeFingerprint(command)
    ) {
      throw new ConflictError('Refund intake key was already used with different request details');
    }
    return { request, order: await this.requireOrder(request.orderId) };
  }

  private intakeId(adminUserId: EntityId, key: string): string {
    return `REF-${createHash('sha256').update(`${adminUserId}\n${key}`).digest('hex').slice(0, 40)}`;
  }

  private intakeFingerprint(command: RequestRefundCommand): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          orderId: command.orderId,
          amountPaise: command.amountPaise ?? null,
          refundCause: command.refundCause ?? 'guest_request',
          reason: command.reason.trim(),
          targetEntitlementIds: command.targetEntitlementIds
            ? [...command.targetEntitlementIds].sort()
            : null,
          ticketLines: command.ticketLines
            ? command.ticketLines
                .map(({ tierId, quantity }) => ({ tierId, quantity }))
                .sort((a, b) => a.tierId.localeCompare(b.tierId))
            : null,
        }),
      )
      .digest('hex');
  }

  private async authoritativeRefundContext(
    order: Order,
  ): Promise<{ cause: RefundCause; eventVersion: number } | null> {
    const event = await this.deps.repositories.events.getById(order.eventId);
    if (event?.status === 'cancelled' || order.eventCancellation)
      return {
        cause: 'organizer_cancel',
        eventVersion: event?.version ?? order.eventCancellation?.eventVersion ?? 1,
      };
    if (!event) return null;
    const affected =
      event.status === 'postponed' ||
      (Number.isFinite(Date.parse(event.lastMaterialChangeAt ?? '')) &&
        Date.parse(order.bookedAt ?? order.createdAt) <=
          Date.parse(event.lastMaterialChangeAt ?? ''));
    return { cause: affected ? 'material_change' : 'guest_request', eventVersion: event.version };
  }

  private async recordPromotedPolicyRemedy(
    request: AdminRefundRequest,
    order: Order,
    context: { cause: RefundCause; eventVersion: number },
    actorId: EntityId,
  ): Promise<void> {
    const full = quoteOriginalRefund(order, request.targetEntitlementIds, context.cause);
    const residual = Math.max(0, full.amountPaise - request.amountPaise);
    if (residual === 0) return;
    const identity = createHash('sha256')
      .update(`${request.id}:${context.eventVersion}`)
      .digest('hex')
      .slice(0, 40);
    const discrepancyId = `REM-${identity}`;
    const store = this.deps.repositories.reconciliations;
    const existingFinding = await store.getDiscrepancy(discrepancyId); // Never reset Admin resolution on replay.
    const now = this.deps.config.clock.now();
    const runId = `REMRUN-${identity}`;
    let run = await store.getRun(runId);
    if (!run) {
      run = createReconciliationRun({ id: runId, requestedBy: actorId, now });
      try {
        await store.createRun(run);
      } catch (error) {
        const winner = await store.getRun(runId);
        if (!winner) throw error;
        run = winner;
      }
    }
    if (!existingFinding) {
      try {
        await store.createDiscrepancies([
          {
            id: discrepancyId,
            runId,
            kind: 'refund_mismatch',
            state: 'finance_review',
            organizationId: order.organizationId,
            orderId: order.id,
            paymentId: order.paymentId,
            payoutId: null,
            amountPaise: residual,
            currency: order.currency,
            evidence: {
              reason: 'policy_remedy_required',
              refundRequestId: request.id,
              selectedEntitlementIds: JSON.stringify(request.targetEntitlementIds),
              originalCause: request.refundCause ?? 'legacy',
              authoritativeCause: context.cause,
              originalEventVersion: request.sourceEventVersion ?? null,
              eventVersion: context.eventVersion,
              originalAffectedPaidPaise: full.amountPaise,
              originalRefundAmountPaise: request.amountPaise,
              residualPlatformFeePaise: Math.max(
                0,
                full.components.platformFeePaise -
                  (request.refundComponents?.platformFeePaise ?? 0),
              ),
              residualPaymentFeePaise: Math.max(
                0,
                full.components.paymentFeePaise - (request.refundComponents?.paymentFeePaise ?? 0),
              ),
              residualFeeTaxPaise: Math.max(
                0,
                full.components.feeTaxPaise - (request.refundComponents?.feeTaxPaise ?? 0),
              ),
              residualOtherPaidPaise: Math.max(
                0,
                full.components.otherPaidPaise - (request.refundComponents?.otherPaidPaise ?? 0),
              ),
            },
            repair: 'recheck_evidence',
            resolutionReason: null,
            resolvedBy: null,
            resolvedAt: null,
            ...newVersionedEntity(now),
          },
        ]);
      } catch (error) {
        if (!(await store.getDiscrepancy(discrepancyId))) throw error;
      }
    }
    if (run.status === 'running') {
      try {
        await store.saveRun(completeReconciliationRun(run, { refundRequests: 1 }, 1, now));
      } catch (error) {
        if ((await store.getRun(runId))?.status !== 'completed') throw error;
      }
    }
  }

  async requestPolicyRemedy(
    adminUserId: EntityId,
    originalRequestId: EntityId,
    meta?: AuditRequestMeta,
  ) {
    const admin = await this.authority.authorize(adminUserId, 'FINANCIAL_REFUND');
    const original = await this.requireRefundRequest(originalRequestId);
    const order = await this.requireOrder(original.orderId);
    const context = await this.authoritativeRefundContext(order);
    if (!context || context.cause === 'guest_request')
      throw new InvalidOperationError(
        'Policy remedy requires authoritative cancellation or qualifying material change',
      );
    const result = await requestOriginalPolicyRemedy(this.deps, {
      originalRequestId,
      requestedBy: admin.id,
      ...context,
    });
    await this.authority.record(admin, {
      action: 'FINANCIAL_REFUND.policy_remedy',
      targetType: 'refund_request',
      targetId: result.request.id,
      before: { originalRequestId, orderStatus: order.status },
      after: { requestStatus: result.request.status, amountPaise: result.request.amountPaise },
      reason: result.request.reason,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return result;
  }

  private async queueSettledPolicyRemedy(request: AdminRefundRequest, actorId: EntityId) {
    if (request.refundCause !== 'guest_request' || request.status !== 'settled') return;
    const order = await this.requireOrder(request.orderId);
    const context = await this.authoritativeRefundContext(order);
    // Cancellation has its bounded full-remaining-order consumer. A material
    // change supplements only the exact admissions already refunded here.
    if (context?.cause !== 'material_change') return;
    const full = quoteOriginalRefund(order, request.targetEntitlementIds, context.cause);
    if (full.amountPaise === request.amountPaise) return;
    const active = (await this.refundRequests.listByOrder(order.id)).find((item) =>
      ['pending', 'approved', 'executing', 'failed'].includes(item.status),
    );
    if (active && active.remedyForRefundRequestId !== request.id) return;
    await requestOriginalPolicyRemedy(this.deps, {
      originalRequestId: request.id,
      requestedBy: actorId,
      ...context,
    });
  }

  async requestRefund(
    adminUserId: EntityId,
    command: RequestRefundCommand,
    meta?: AuditRequestMeta,
  ): Promise<{ request: AdminRefundRequest; order: Order }> {
    const admin = await this.authority.authorize(adminUserId, 'FINANCIAL_REFUND');
    const replay = command.intakeKey ? await this.replayIntake(adminUserId, command) : null;
    if (replay) return replay;
    const order = await this.requireOrder(command.orderId);
    if (order.status !== 'paid') {
      throw new InvalidOperationError(`Order ${order.id} is not paid — nothing to refund`);
    }
    const remaining = refundableBalance(order);
    const orderEntitlements = await this.entitlements.getByOrderId(order.id);
    const selection =
      order.refundSnapshot && !command.targetEntitlementIds && !command.ticketLines
        ? {
            ...command,
            targetEntitlementIds: orderEntitlements
              .filter((ticket) => ticket.status !== 'void')
              .map((ticket) => ticket.id),
          }
        : command;
    const { ticketLines, targetEntitlementIds } = selectRefundTargets(orderEntitlements, selection);
    let quoted: ReturnType<typeof quoteOriginalRefund> | undefined;
    let sourceEventVersion: number | undefined;
    let amountPaise = command.amountPaise;
    if (order.refundSnapshot) {
      const context = await this.authoritativeRefundContext(order);
      if (!context)
        throw new InvalidOperationError('Event details are required to establish refund cause');
      sourceEventVersion = context.eventVersion;
      if (command.refundCause === 'organizer_cancel' && context.cause !== 'organizer_cancel')
        throw new InvalidOperationError(
          'Organizer cancellation refund requires authoritative cancellation',
        );
      if (command.refundCause === 'material_change' && context.cause === 'guest_request')
        throw new InvalidOperationError(
          'Material-change refund requires an authoritative qualifying event change',
        );
      const cause = context.cause;
      quoted = quoteOriginalRefund(order, targetEntitlementIds, cause);
      if (command.amountPaise !== undefined && command.amountPaise !== quoted.amountPaise)
        throw new InvalidOperationError(
          'Refund amount must match the original purchase policy quote',
        );
      amountPaise = quoted.amountPaise;
    }
    if (amountPaise === undefined || !Number.isSafeInteger(amountPaise) || amountPaise <= 0)
      throw new InvalidOperationError('A positive explicit amount is required for legacy refunds');
    if (amountPaise > remaining)
      throw new InvalidOperationError(
        `Refund of ${amountPaise} exceeds order ${order.id}'s refundable balance of ${remaining}`,
      );
    if (
      ticketLines.length > 0 &&
      amountPaise === remaining &&
      targetEntitlementIds.length <
        orderEntitlements.filter((ticket) => ticket.status !== 'void').length
    )
      throw new InvalidOperationError(
        'Refunding the full remaining order balance requires selecting every active ticket',
      );

    const coverAccounts = await this.getCoverAccounts(order, orderEntitlements);
    await this.assertCoverRefundScope(
      order,
      amountPaise,
      ticketLines.length > 0 &&
        targetEntitlementIds.length <
          orderEntitlements.filter((ticket) => ticket.status !== 'void').length,
      coverAccounts,
    );
    const hasRedeemedEntitlement = orderEntitlements.some(
      (ticket) =>
        ticket.status === 'redeemed' ||
        ticket.ticketAddons?.some((addon) => addon.status === 'redeemed'),
    );
    const now = this.deps.config.clock.now();
    const settings = await this.deps.repositories.platformSettings.get();
    const request = createRefundRequest({
      id: command.intakeKey ? this.intakeId(admin.id, command.intakeKey) : this.deps.config.ids(),
      intakeFingerprint: this.intakeFingerprint(command),
      orderId: order.id,
      organizationId: order.organizationId,
      amountPaise,
      requestedBy: admin.id,
      reason: command.reason,
      scope: ticketLines.length > 0 ? 'ticket_lines' : 'amount_only',
      ticketLines,
      targetEntitlementIds,
      ...(quoted
        ? {
            sourceEventVersion,
            refundCause: quoted.cause,
            refundComponents: quoted.components,
            purchasePolicyVersion: quoted.purchasePolicyVersion,
          }
        : {}),
      hasRedeemedEntitlement,
      thresholds: {
        singleApproverCeilingPaise: settings.refundSingleApproverThresholdPaise,
        dualApproverCeilingPaise: settings.refundDualApproverThresholdPaise,
      },
      now,
    });
    const committed = await this.orders.beginRefundRequest({
      request,
      expectedOrderVersion: order.version,
      ...(sourceEventVersion !== undefined ? { expectedEventVersion: sourceEventVersion } : {}),
      expectedEntitlementVersions: orderEntitlements.map((ticket) => ({
        id: ticket.id,
        version: ticket.version,
      })),
      now,
    });
    await this.authority.record(admin, {
      action: 'FINANCIAL_REFUND.request',
      targetType: 'refund_request',
      targetId: committed.request.id,
      before: { orderStatus: order.status },
      after: { orderStatus: committed.order.status, requestStatus: committed.request.status },
      reason: committed.request.reason,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    this.deps.logger.info('refund.requested', {
      requestId: committed.request.id,
      orderId: order.id,
      amountPaise,
      approversRequired: committed.request.approversRequired,
    });
    return committed;
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
    const order = await this.requireOrder(request.orderId);
    const context =
      request.status === 'approved' &&
      request.refundCause === 'guest_request' &&
      order.refundSnapshot
        ? await this.authoritativeRefundContext(order)
        : null;
    const rejected =
      context && context.cause !== 'guest_request'
        ? rejectUnexecutedRefundForPolicyChange(request, admin.id, reason, now)
        : rejectRefundRequest(request, admin.id, reason, now);
    await this.refundRequests.save(rejected);

    // The order was locked when the request was created — restore it via the
    // dedicated function, never a value chosen here. This is the exact fix
    // for v1's admin console hardcoding the restore status on rejection.
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
    if (request.refundCause === 'guest_request' && order.refundSnapshot) {
      const context = await this.authoritativeRefundContext(order);
      if (context && context.cause !== 'guest_request') {
        if (
          ['pending', 'approved'].includes(request.status) &&
          request.executionAttempts === 0 &&
          !request.providerRefundId
        )
          throw new ConflictError(
            'Event refund policy changed; reject and recreate this request under the full original-purchase policy before execution',
          );
        if (
          request.executionAttempts > 0 ||
          request.providerRefundId ||
          request.status === 'settled'
        )
          await this.recordPromotedPolicyRemedy(request, order, context, admin.id);
      }
    }
    if (request.status === 'settled') {
      order = await this.requireOrder(order.id);
      request = await this.ensureSettledExecutionIntents(request, order, admin, meta);
      return { request, order: await this.requireOrder(order.id) };
    }
    // Recheck and freeze at execution: an approved request may predate delayed
    // cover issuance, and a Venue redemption must not race provider movement.
    const orderEntitlements = await this.entitlements.getByOrderId(order.id);
    const coverAccounts = await this.getCoverAccounts(order, orderEntitlements);
    await this.assertCoverRefundScope(
      order,
      request.amountPaise,
      request.scope === 'ticket_lines' &&
        request.targetEntitlementIds.length <
          orderEntitlements.filter((ticket) => ticket.status !== 'void').length,
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

    // Financial side effects cannot precede complete original capture accounting.
    // This recovery never grants admission or changes the refund lock.
    await new CheckoutService(this.deps).repairSaleAccounting(order.id);
    const now = this.deps.config.clock.now();
    if (request.status === 'executing' && request.providerRefundId === null) {
      throw new ConflictError(
        request.failureReason
          ? 'Refund provider result requires reconciliation before retry'
          : 'Refund execution is already in progress or requires reconciliation',
      );
    }
    if (request.status === 'approved' || request.status === 'failed') {
      const claimed = {
        ...beginRefundExecution(request, now),
        executionActor: this.executionActorSnapshot(admin, 'execution_claim', now, meta),
      };
      try {
        await this.refundRequests.save(claimed);
        request = claimed;
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
        const winner = await this.requireRefundRequest(refundRequestId);
        if (winner.status === 'settled') {
          order = await this.requireOrder(order.id);
          return {
            request: await this.ensureSettledExecutionIntents(winner, order, admin, meta),
            order: await this.requireOrder(order.id),
          };
        }
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
    }
    // A lifecycle change can race the external provider operation. Its saved
    // fact remains authoritative; separately retain any newly owed components.
    if (request.refundCause === 'guest_request' && order.refundSnapshot) {
      const context = await this.authoritativeRefundContext(order);
      if (context && context.cause !== 'guest_request')
        await this.recordPromotedPolicyRemedy(request, order, context, admin.id);
    }
    if (request.providerStatus === 'failed') {
      const recorded = await this.deps.repositories.providerPayments.findByPaymentId(
        order.paymentId,
      );
      if (request.providerRefundId && recorded?.refunds[request.providerRefundId] !== undefined) {
        throw new ConflictError('Provider refund conflicts with a recorded processed refund');
      }
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
      ...(request.refundComponents ? { refundComponents: request.refundComponents } : {}),
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

    const selectedTickets =
      request.scope === 'ticket_lines'
        ? await Promise.all(request.targetEntitlementIds.map((id) => this.entitlements.getById(id)))
        : [];
    const settledTicketClaims = selectedTickets.map((ticket) => {
      if (!ticket || ticket.orderId !== order.id)
        throw new InvalidOperationError('Refund ticket selection no longer matches the order');
      const line = order.lines.find((row) => row.tierId === ticket.tierId);
      if (!line) throw new InvalidOperationError('Refund ticket tier no longer matches the order');
      return {
        entitlementId: ticket.id,
        tierId: ticket.tierId,
        ...(line.pricingPhaseId === undefined ? {} : { pricingPhaseId: line.pricingPhaseId }),
      };
    });
    const refundedOrder = applyOrderRefund(
      order,
      request.amountPaise,
      now,
      request.id,
      settledTicketClaims,
    );
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
    const settled = {
      ...markRefundSettled(request, request.providerRefundId, now),
      executionActor:
        request.executionActor ?? this.executionActorSnapshot(admin, 'legacy_recovery', now, meta),
      settlementAudit: {
        requestStatusBefore: request.status,
        orderStatusBefore: order.status,
        orderStatusAfter: refundedOrder.status,
        occurredAt: now.getTime(),
      },
    };
    await this.refundRequests.save(settled);
    const repaired = await this.ensureSettledExecutionIntents(settled, refundedOrder, admin, meta);
    return { request: repaired, order: await this.requireOrder(refundedOrder.id) };
  }

  private executionActorSnapshot(
    admin: PlatformAdmin,
    source: NonNullable<AdminRefundRequest['executionActor']>['source'],
    now: Date,
    meta?: AuditRequestMeta,
  ): NonNullable<AdminRefundRequest['executionActor']> {
    return {
      adminId: admin.id,
      adminRole: admin.role,
      source,
      authorizedAt: now.toISOString(),
      ...(meta?.ipAddress ? { ipAddress: meta.ipAddress } : {}),
      ...(meta?.userAgent ? { userAgent: meta.userAgent } : {}),
    };
  }

  /** Terminal-state retries repair only durable intents, never provider/admission effects. */
  private async ensureSettledExecutionIntents(
    request: AdminRefundRequest,
    order: Order,
    admin: PlatformAdmin,
    meta?: AuditRequestMeta,
  ): Promise<AdminRefundRequest> {
    if (request.status !== 'settled' || !request.providerRefundId)
      throw new InvalidOperationError('Refund settlement evidence is incomplete');
    if (!request.executionActor || !request.settlementAudit) {
      const now = this.deps.config.clock.now();
      const recovered = {
        ...request,
        version: request.version + 1,
        updatedAt: now.toISOString(),
        executionActor:
          request.executionActor ??
          this.executionActorSnapshot(admin, 'legacy_recovery', now, meta),
        settlementAudit: request.settlementAudit ?? {
          requestStatusBefore: 'unknown',
          orderStatusBefore: 'unknown',
          orderStatusAfter: order.status,
          occurredAt: now.getTime(),
        },
      };
      try {
        await this.refundRequests.save(recovered);
        request = recovered;
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
        request = await this.requireRefundRequest(request.id);
        if (request.status !== 'settled' || !request.executionActor || !request.settlementAudit)
          throw new ConflictError('Refund settlement audit recovery changed concurrently');
      }
    }
    const actor = request.executionActor;
    const audit = request.settlementAudit;
    const providerRefundId = request.providerRefundId;
    if (!actor || !audit || !providerRefundId)
      throw new InvalidOperationError('Refund execution attribution is unavailable');
    // Keep the existing policy remedy workflow independent and replayable.
    await this.queueSettledPolicyRemedy(request, admin.id);
    await this.deps.outbox.append(
      domainEvent({
        id: deterministicDomainEventId('finance.refund.settled', request.id),
        type: 'finance.refund.settled',
        aggregateId: request.id,
        organizationId: order.organizationId,
        actorId: actor.adminId,
        payload: {
          refundRequestId: request.id,
          orderId: order.id,
          amountPaise: request.amountPaise,
          providerRefundId,
        },
        occurredAt: audit.occurredAt,
      }),
    );
    await this.deps.adminAudit.append({
      id: deterministicDomainEventId('finance.refund.settled', request.id, 'execution-audit'),
      adminId: actor.adminId,
      adminRole: actor.adminRole,
      action: 'FINANCIAL_REFUND.execute',
      targetType: 'refund_request',
      targetId: request.id,
      before: { status: audit.requestStatusBefore, orderStatus: audit.orderStatusBefore },
      after: {
        status: 'settled',
        orderStatus: audit.orderStatusAfter,
        executionActorSource: actor.source,
      },
      reason: request.reason,
      occurredAt: audit.occurredAt,
      ...(actor.ipAddress ? { ipAddress: actor.ipAddress } : {}),
      ...(actor.userAgent ? { userAgent: actor.userAgent } : {}),
    });
    return request;
  }

  /** Records fetched evidence only; existing execute handles internal convergence. */
  async reconcileRefund(
    adminUserId: EntityId,
    refundRequestId: EntityId,
    command: { providerRefundId: string; reason: string },
    meta?: AuditRequestMeta,
  ): Promise<{ request: AdminRefundRequest; order: Order }> {
    const admin = await this.authority.authorize(adminUserId, 'FINANCIAL_REFUND');
    const request = await this.requireRefundRequest(refundRequestId);
    const order = await this.requireOrder(request.orderId);
    if (!command.reason.trim() || command.reason.length > 2000) {
      throw new InvalidOperationError('Refund reconciliation requires an operator reason');
    }
    if (request.providerRefundId && request.providerRefundId !== command.providerRefundId) {
      throw new ConflictError('A different provider refund is already linked');
    }
    if (request.status === 'settled') return { request, order };
    if (
      request.status !== 'executing' ||
      !order.paymentId ||
      order.organizationId !== request.organizationId
    ) {
      throw new ConflictError('Only an executing refund can be reconciled');
    }
    const audit = {
      targetType: 'refund_request',
      targetId: request.id,
      reason: command.reason.trim(),
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    };
    await this.authority.record(admin, {
      ...audit,
      action: 'FINANCIAL_REFUND.reconcile.requested',
      before: { status: request.status, providerRefundId: request.providerRefundId },
      after: { candidateProviderRefundId: command.providerRefundId },
    });
    const fact = await this.deps.paymentProvider.getRefund(
      order.paymentId,
      command.providerRefundId,
    );
    if (
      fact.id !== command.providerRefundId ||
      fact.paymentId !== order.paymentId ||
      fact.amountPaise !== request.amountPaise ||
      fact.currency !== order.currency ||
      fact.receipt !== request.executionIdempotencyKey ||
      !['pending', 'processed', 'failed'].includes(fact.status)
    ) {
      throw new ConflictError('Provider refund does not match the original execution');
    }
    if (
      (request.providerStatus === 'processed' || request.providerStatus === 'failed') &&
      request.providerStatus !== fact.status
    ) {
      throw new ConflictError('Provider refund conflicts with a saved terminal fact');
    }
    const payment = await this.deps.repositories.providerPayments.findByPaymentId(order.paymentId);
    const processedAmount = payment?.refunds[fact.id];
    if (
      processedAmount !== undefined &&
      (fact.status !== 'processed' || processedAmount !== fact.amountPaise)
    ) {
      throw new ConflictError('Provider refund conflicts with a recorded processed refund');
    }
    await this.authority.record(admin, {
      ...audit,
      action: 'FINANCIAL_REFUND.reconcile.observed',
      before: {
        providerRefundId: request.providerRefundId,
        providerStatus: request.providerStatus,
      },
      after: {
        providerRefundId: fact.id,
        providerStatus: fact.status,
        amountPaise: fact.amountPaise,
      },
    });
    if (request.providerRefundId === fact.id && request.providerStatus === fact.status) {
      return { request, order };
    }
    const reconciled = recordRefundProviderFact(
      request,
      fact.id,
      fact.status,
      this.deps.config.clock.now(),
    );
    await this.refundRequests.save(reconciled);
    return { request: reconciled, order };
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
