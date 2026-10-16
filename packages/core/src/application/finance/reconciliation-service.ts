import { NotFoundError } from '../../domain/errors.js';
import { newVersionedEntity } from '../../domain/identity.js';
import { journalTotals } from '../../domain/models/financial-journal.js';
import {
  completeReconciliationRun,
  createReconciliationRun,
  failReconciliationRun,
  resolveReconciliationDiscrepancy,
} from '../../domain/models/reconciliation.js';

import type { EntityId } from '../../domain/identity.js';
import type { Order } from '../../domain/models/order.js';
import type { ProviderPayment } from '../../domain/models/provider-payment.js';
import type {
  ReconciliationDiscrepancy,
  ReconciliationDiscrepancyKind,
  ReconciliationDiscrepancyState,
  ReconciliationRun,
} from '../../domain/models/reconciliation.js';
import type { Page } from '../../domain/ports/repositories.js';
import type { ServiceDeps } from '../context.js';

const PAGE_SIZE = 200;
const DEFAULT_PENDING_AGE_MS = 30 * 60 * 1000;
type Evidence = ReconciliationDiscrepancy['evidence'];

async function collectAll<T>(loadPage: (cursor: string | null) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page = await loadPage(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

export class ReconciliationService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly stalePendingAgeMs = DEFAULT_PENDING_AGE_MS,
  ) {}

  async run(requestedBy: EntityId): Promise<ReconciliationRun> {
    const now = this.deps.config.clock.now();
    const run = createReconciliationRun({
      id: `recon-${this.deps.config.ids()}`,
      requestedBy,
      now,
    });
    await this.deps.repositories.reconciliations.createRun(run);

    try {
      const [orders, payments, entitlements, payouts] = await Promise.all([
        collectAll((cursor) => this.deps.repositories.orders.listAll({ cursor, limit: PAGE_SIZE })),
        collectAll((cursor) =>
          this.deps.repositories.providerPayments.listAll({ cursor, limit: PAGE_SIZE }),
        ),
        collectAll((cursor) =>
          this.deps.repositories.entitlements.listAll({ cursor, limit: PAGE_SIZE }),
        ),
        collectAll((cursor) =>
          this.deps.repositories.payouts.listByStatus(null, { cursor, limit: PAGE_SIZE }),
        ),
      ]);

      const discrepancies = await this.compare(
        run.id,
        now,
        orders,
        payments,
        entitlements,
        payouts,
      );
      await this.deps.repositories.reconciliations.createDiscrepancies(discrepancies);
      const completed = completeReconciliationRun(
        run,
        {
          orders: orders.length,
          providerPayments: payments.length,
          entitlements: entitlements.length,
          payouts: payouts.length,
        },
        discrepancies.length,
        this.deps.config.clock.now(),
      );
      await this.deps.repositories.reconciliations.saveRun(completed);
      return completed;
    } catch (error) {
      const failed = failReconciliationRun(
        run,
        error instanceof Error ? error.message : 'Unknown reconciliation failure',
        this.deps.config.clock.now(),
      );
      await this.deps.repositories.reconciliations.saveRun(failed);
      throw error;
    }
  }

  getRun(id: EntityId): Promise<ReconciliationRun | null> {
    return this.deps.repositories.reconciliations.getRun(id);
  }

  listRuns(query: { cursor?: string | null; limit: number }) {
    return this.deps.repositories.reconciliations.listRuns(query);
  }

  listDiscrepancies(query: {
    cursor?: string | null;
    limit: number;
    runId?: EntityId;
    state?: ReconciliationDiscrepancyState;
  }) {
    return this.deps.repositories.reconciliations.listDiscrepancies(query);
  }

  getDiscrepancy(id: EntityId) {
    return this.deps.repositories.reconciliations.getDiscrepancy(id);
  }

  async resolve(
    id: EntityId,
    reason: string,
    resolvedBy: EntityId,
  ): Promise<ReconciliationDiscrepancy> {
    const discrepancy = await this.deps.repositories.reconciliations.getDiscrepancy(id);
    if (!discrepancy) throw new NotFoundError('Reconciliation discrepancy', id);
    const resolved = resolveReconciliationDiscrepancy(
      discrepancy,
      resolvedBy,
      reason,
      this.deps.config.clock.now(),
    );
    if (resolved !== discrepancy) {
      await this.deps.repositories.reconciliations.saveDiscrepancy(resolved);
    }
    return resolved;
  }

  private discrepancy(
    runId: EntityId,
    now: Date,
    kind: ReconciliationDiscrepancyKind,
    input: {
      organizationId?: EntityId | null;
      orderId?: EntityId | null;
      paymentId?: string | null;
      payoutId?: EntityId | null;
      amountPaise?: number | null;
      currency?: string | null;
      evidence: Evidence;
      state?: ReconciliationDiscrepancyState;
    },
  ): ReconciliationDiscrepancy {
    return {
      id: `recon-item-${this.deps.config.ids()}`,
      runId,
      kind,
      state: input.state ?? 'open',
      organizationId: input.organizationId ?? null,
      orderId: input.orderId ?? null,
      paymentId: input.paymentId ?? null,
      payoutId: input.payoutId ?? null,
      amountPaise: input.amountPaise ?? null,
      currency: input.currency ?? null,
      evidence: input.evidence,
      repair: 'recheck_evidence',
      resolutionReason: null,
      resolvedBy: null,
      resolvedAt: null,
      ...newVersionedEntity(now),
    };
  }

  private async compare(
    runId: EntityId,
    now: Date,
    orders: Order[],
    payments: ProviderPayment[],
    entitlements: Awaited<
      ReturnType<ServiceDeps['repositories']['entitlements']['listAll']>
    >['items'],
    payouts: Awaited<ReturnType<ServiceDeps['repositories']['payouts']['listByStatus']>>['items'],
  ): Promise<ReconciliationDiscrepancy[]> {
    const found: ReconciliationDiscrepancy[] = [];
    const ordersById = new Map(orders.map((order) => [order.id, order]));
    const paymentsById = new Map(payments.map((payment) => [payment.id, payment]));
    const ticketsByOrder = new Map<EntityId, typeof entitlements>();
    for (const ticket of entitlements) {
      const set = ticketsByOrder.get(ticket.orderId) ?? [];
      set.push(ticket);
      ticketsByOrder.set(ticket.orderId, set);
      const order = ordersById.get(ticket.orderId);
      if (!order || !['paid', 'refund_requested', 'refunded'].includes(order.status)) {
        found.push(
          this.discrepancy(runId, now, 'ticket_without_paid_order', {
            organizationId: ticket.organizationId,
            orderId: ticket.orderId,
            evidence: { entitlementId: ticket.id, orderStatus: order?.status ?? 'missing' },
          }),
        );
      }
    }

    for (const payment of payments) {
      if (payment.capturedPaise > 0 && (!payment.orderId || !ordersById.has(payment.orderId))) {
        found.push(
          this.discrepancy(runId, now, 'captured_payment_without_order', {
            orderId: payment.orderId,
            paymentId: payment.id,
            amountPaise: payment.capturedPaise,
            currency: payment.currency,
            evidence: {
              processingState: payment.processingState,
              providerOrderId: payment.providerOrderId,
            },
            state: 'support_required',
          }),
        );
      }
    }

    const staleBefore = now.getTime() - this.stalePendingAgeMs;
    for (const order of orders) {
      const payment = order.paymentId ? paymentsById.get(order.paymentId) : undefined;
      if (['paid', 'refund_requested', 'refunded'].includes(order.status)) {
        if (!payment || payment.capturedPaise <= 0) {
          found.push(
            this.discrepancy(runId, now, 'paid_order_without_capture', {
              organizationId: order.organizationId,
              orderId: order.id,
              paymentId: order.paymentId,
              amountPaise: order.grandTotalPaise,
              currency: order.currency,
              evidence: { orderStatus: order.status, providerRecordPresent: Boolean(payment) },
              state: 'support_required',
            }),
          );
        }
        const expectedTickets = order.lines.reduce((sum, item) => sum + item.quantity, 0);
        const actualTickets = ticketsByOrder.get(order.id)?.length ?? 0;
        if (actualTickets !== expectedTickets) {
          found.push(
            this.discrepancy(runId, now, 'paid_order_without_ticket', {
              organizationId: order.organizationId,
              orderId: order.id,
              paymentId: order.paymentId,
              evidence: { expectedTickets, actualTickets, orderStatus: order.status },
              state: 'support_required',
            }),
          );
        }
      }

      if (
        ['pending', 'awaiting_payment'].includes(order.status) &&
        Date.parse(order.updatedAt) < staleBefore
      ) {
        found.push(
          this.discrepancy(runId, now, 'stale_pending_payment', {
            organizationId: order.organizationId,
            orderId: order.id,
            paymentId: order.paymentId,
            evidence: { orderStatus: order.status, updatedAt: order.updatedAt },
          }),
        );
      }

      if (payment) {
        if (payment.capturedPaise !== order.grandTotalPaise) {
          found.push(
            this.discrepancy(runId, now, 'amount_mismatch', {
              organizationId: order.organizationId,
              orderId: order.id,
              paymentId: payment.id,
              amountPaise: payment.capturedPaise,
              currency: payment.currency,
              evidence: { orderAmountPaise: order.grandTotalPaise },
              state: 'finance_review',
            }),
          );
        }
        if (payment.currency.toUpperCase() !== order.currency.toUpperCase()) {
          found.push(
            this.discrepancy(runId, now, 'currency_mismatch', {
              organizationId: order.organizationId,
              orderId: order.id,
              paymentId: payment.id,
              currency: payment.currency,
              evidence: { orderCurrency: order.currency },
              state: 'finance_review',
            }),
          );
        }
        if (payment.providerOrderId !== order.paymentIntentId) {
          found.push(
            this.discrepancy(runId, now, 'provider_order_mismatch', {
              organizationId: order.organizationId,
              orderId: order.id,
              paymentId: payment.id,
              evidence: {
                providerOrderId: payment.providerOrderId,
                orderPaymentIntentId: order.paymentIntentId,
              },
              state: 'support_required',
            }),
          );
        } else if (order.paymentIntentId) {
          const hold = await this.deps.repositories.cartReservations.getByProviderOrderId(
            order.paymentIntentId,
          );
          if (!hold || hold.convertedOrderId !== order.id || hold.status !== 'converted') {
            found.push(
              this.discrepancy(runId, now, 'provider_order_mismatch', {
                organizationId: order.organizationId,
                orderId: order.id,
                paymentId: payment.id,
                evidence: {
                  providerOrderId: order.paymentIntentId,
                  holdId: hold?.id ?? null,
                  holdStatus: hold?.status ?? 'missing',
                  convertedOrderId: hold?.convertedOrderId ?? null,
                },
                state: 'support_required',
              }),
            );
          }
        }
        const providerRefunded = Object.values(payment.refunds).reduce(
          (sum, value) => sum + value,
          0,
        );
        if (providerRefunded !== order.refundedPaise) {
          found.push(
            this.discrepancy(runId, now, 'refund_mismatch', {
              organizationId: order.organizationId,
              orderId: order.id,
              paymentId: payment.id,
              amountPaise: providerRefunded,
              currency: payment.currency,
              evidence: { orderRefundedPaise: order.refundedPaise },
              state: 'finance_review',
            }),
          );
        }
      }

      const journals = await this.deps.repositories.financialJournals.findByOrderId(order.id);
      const keys = new Set<string>();
      for (const journal of journals) {
        const totals = journalTotals(journal);
        if (totals.debitPaise !== totals.creditPaise) {
          found.push(
            this.discrepancy(runId, now, 'unbalanced_journal', {
              organizationId: order.organizationId,
              orderId: order.id,
              paymentId: order.paymentId,
              evidence: {
                journalId: journal.id,
                debitPaise: totals.debitPaise,
                creditPaise: totals.creditPaise,
              },
              state: 'finance_review',
            }),
          );
        }
        if (keys.has(journal.idempotencyKey)) {
          found.push(
            this.discrepancy(runId, now, 'duplicate_journal', {
              organizationId: order.organizationId,
              orderId: order.id,
              evidence: { idempotencyKey: journal.idempotencyKey },
              state: 'finance_review',
            }),
          );
        }
        keys.add(journal.idempotencyKey);
      }
      if (order.status === 'paid' && order.grandTotalPaise > 0) {
        for (const suffix of [':collection', ':allocation']) {
          if (!journals.some((journal) => journal.idempotencyKey.endsWith(suffix))) {
            found.push(
              this.discrepancy(runId, now, 'missing_journal', {
                organizationId: order.organizationId,
                orderId: order.id,
                paymentId: order.paymentId,
                evidence: { requiredJournal: suffix.slice(1) },
                state: 'finance_review',
              }),
            );
          }
        }
      }

      if (payment && Object.keys(payment.disputes).length > 0) {
        const chargebackJournals = journals.filter(
          (journal) =>
            journal.source.type === 'chargeback' || journal.source.type === 'chargeback_reversal',
        );
        for (const [disputeId, dispute] of Object.entries(payment.disputes)) {
          const hasHold = chargebackJournals.some((journal) => journal.source.id === disputeId);
          if (!hasHold) {
            found.push(
              this.discrepancy(runId, now, 'chargeback_mismatch', {
                organizationId: order.organizationId,
                orderId: order.id,
                paymentId: payment.id,
                amountPaise: dispute.amountPaise,
                currency: payment.currency,
                evidence: { disputeId, disputeStatus: dispute.status },
                state: 'finance_review',
              }),
            );
          }
        }
      }
    }

    for (const payout of payouts) {
      if (payout.status !== 'paid') continue;
      const journals = await this.deps.repositories.financialJournals.findBySource(
        'payout_completion',
        payout.id,
      );
      if (journals.length !== 1) {
        found.push(
          this.discrepancy(runId, now, 'payout_mismatch', {
            organizationId: payout.organizationId,
            payoutId: payout.id,
            amountPaise: payout.amount,
            evidence: { completionJournalCount: journals.length },
            state: 'finance_review',
          }),
        );
      }
    }
    return found;
  }
}
