import type { EntityId } from '../../domain/identity.js';
import type { ServiceDeps } from '../context.js';
import type { CheckoutService, FulfilmentGap } from './checkout-service.js';

export interface FulfilmentRepairOptions {
  /** Look this far back (by order creation time). */
  lookbackMs: number;
  /** Ignore orders newer than this: they may simply still be mid-fulfilment. */
  settleMs: number;
  /** Stop after examining this many orders. */
  maxOrders: number;
  /** Report only; change nothing. */
  dryRun: boolean;
}

export const DEFAULT_REPAIR_OPTIONS: FulfilmentRepairOptions = {
  lookbackMs: 48 * 60 * 60 * 1000,
  settleMs: 10 * 60 * 1000,
  maxOrders: 500,
  dryRun: true,
};

export interface FulfilmentRepairFinding {
  orderId: EntityId;
  missing: FulfilmentGap[];
  /** `repaired` / `still_incomplete` / `error` only when not a dry run. */
  outcome: 'found' | 'repaired' | 'still_incomplete' | 'error';
  detail?: string;
}

export interface FulfilmentRepairReport {
  scanned: number;
  complete: number;
  findings: FulfilmentRepairFinding[];
  /** True when `maxOrders` stopped the scan before the lookback window ended. */
  truncated: boolean;
}

const PAGE_SIZE = 100;

/**
 * ─── Fulfilment repair ───────────────────────────────────────────────────────
 *
 * Fulfilment is idempotent but not one transaction, so a crash can leave a
 * charged order without its hold conversion, tickets or ledger entry. Provider
 * webhooks are redelivered for a day, which usually finishes the job, but
 * nothing noticed an order for which that did not happen. This finds paid
 * orders in a recent window that are missing a step and (unless `dryRun`)
 * finishes them with the SAME steps fulfilment uses. It never decides whether
 * a payment happened, and never touches an order that is not already paid.
 */
export class FulfilmentRepairService {
  constructor(
    private deps: ServiceDeps,
    private checkout: CheckoutService,
  ) {}

  async sweep(overrides: Partial<FulfilmentRepairOptions> = {}): Promise<FulfilmentRepairReport> {
    const options = { ...DEFAULT_REPAIR_OPTIONS, ...overrides };
    const now = this.deps.config.clock.now().getTime();
    const oldest = now - options.lookbackMs;
    const newest = now - options.settleMs;
    const report: FulfilmentRepairReport = {
      scanned: 0,
      complete: 0,
      findings: [],
      truncated: false,
    };

    let cursor: string | null = null;
    for (;;) {
      // Newest first, so the scan can stop as soon as it passes the window.
      const page = await this.deps.repositories.orders.listAll({ limit: PAGE_SIZE, cursor });
      for (const order of page.items) {
        const createdAt = Date.parse(order.createdAt);
        if (createdAt < oldest) return report;
        if (createdAt > newest || order.status !== 'paid' || !order.paymentId) continue;
        if (report.scanned >= options.maxOrders) {
          report.truncated = true;
          return report;
        }
        report.scanned += 1;
        await this.examine(order.id, options.dryRun, report);
      }
      if (page.nextCursor === null) return report;
      cursor = page.nextCursor;
    }
  }

  private async examine(
    orderId: EntityId,
    dryRun: boolean,
    report: FulfilmentRepairReport,
  ): Promise<void> {
    try {
      const order = await this.deps.repositories.orders.getById(orderId);
      if (!order) return;
      const gaps = await this.checkout.assessFulfilment(order);
      if (gaps.holdFound && gaps.missing.length === 0) {
        report.complete += 1;
        return;
      }
      if (!gaps.holdFound) {
        report.findings.push({
          orderId,
          missing: gaps.missing,
          outcome: 'still_incomplete',
          detail: 'No hold is bound to this order, so it cannot be repaired automatically',
        });
        return;
      }
      if (dryRun) {
        report.findings.push({ orderId, missing: gaps.missing, outcome: 'found' });
        return;
      }
      const after = await this.checkout.repairFulfilment(orderId);
      report.findings.push({
        orderId,
        missing: gaps.missing,
        outcome: after.missing.length === 0 ? 'repaired' : 'still_incomplete',
        ...(after.missing.length === 0
          ? {}
          : { detail: `Still missing: ${after.missing.join(', ')}` }),
      });
    } catch (error) {
      report.findings.push({
        orderId,
        missing: [],
        outcome: 'error',
        detail: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }
}
