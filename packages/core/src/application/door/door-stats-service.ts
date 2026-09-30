import { NotFoundError } from '../../domain/errors.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  EventCatalogRepository,
  EventRepository,
  ScanLedgerRepository,
  DoorSaleRepository,
  CoverWalletRepository,
} from '../../domain/ports/repositories.js';
import type { ActorContext } from '../context.js';

/**
 * ─── Door Stats (Phase 5, Founder Task B2) ──────────────────────────────────
 * A read model over three domains that don't otherwise share a service:
 * scan-ledger counts, door-sale totals, cover-wallet balances — all for one
 * event. Deliberately its own small service rather than folded into
 * `ScannerService` (which owns scanning, not door-sale or wallet data) or
 * `CoverWalletService` (which owns wallet mutations, not cross-domain reads).
 *
 * Every count below comes from an existing repository aggregate
 * (`countByEventAndStatus`/`getEventStats`) — Firestore `.count()` queries,
 * never a full document read, so this stays cheap enough to poll.
 * `GET /door/stats/ws` (live push) still needs `@fastify/websocket`
 * registered on the app, which it isn't — polling only for now.
 */

export interface DoorStatsServiceDeps {
  events: EventRepository;
  /** Supplies the tier names the admissions breakdown is computed against. */
  catalog: EventCatalogRepository;
  scanLedger: ScanLedgerRepository;
  doorSales: DoorSaleRepository;
  coverWallets: CoverWalletRepository;
}

export interface DoorStats {
  eventId: EntityId;
  /**
   * The number the door actually watches. `capacity` is null when the event
   * has none configured — the gauge then shows a count with no limit rather
   * than inventing one (the old scanner UI hardcoded 500, which told staff a
   * confident number nobody had set).
   */
  occupancy: {
    inside: number;
    capacity: number | null;
    remaining: number | null;
    /** Admitted on a ticket bought before tonight. */
    prebooked: number;
    /** Admitted by a sale taken at the door. */
    doorEntries: number;
  };
  /** Admitted people per entry class (stag / couple / VIP …). */
  byEntryType: Record<string, number>;
  scans: {
    total: number;
    consumed: number;
    denied: number;
    pending: number;
    revoked: number;
    overridden: number;
    expired: number;
    cancelled: number;
  };
  doorSales: {
    count: number;
    grossPaise: number;
  };
  coverWallet: {
    activeWallets: number;
    totalBalancePaise: number;
    totalCreditsPaise: number;
    totalDebitsPaise: number;
  };
  generatedAt: string;
}

export interface DoorStatsService {
  getStats(eventId: EntityId, actor: ActorContext): Promise<DoorStats>;
}

export function createDoorStatsService(deps: DoorStatsServiceDeps): DoorStatsService {
  async function getStats(eventId: EntityId, actor: ActorContext): Promise<DoorStats> {
    const event = await deps.events.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    requireOrgAccess(actor, event.organizationId);

    // Fetched first: the breakdown is computed against the tiers the event
    // actually sells rather than against whatever strings happen to be in the
    // ledger, so a renamed tier cannot invent a category.
    const tiers = await deps.catalog.listTiers(eventId);
    const tierNames = [...new Set(tiers.map((tier) => tier.name))];

    const [
      consumed,
      denied,
      pending,
      revoked,
      overridden,
      expired,
      cancelled,
      doorStats,
      walletStats,
      admissions,
      doorSalesPage,
    ] = await Promise.all([
      deps.scanLedger.countByEventAndStatus(eventId, 'consumed'),
      deps.scanLedger.countByEventAndStatus(eventId, 'denied'),
      deps.scanLedger.countByEventAndStatus(eventId, 'pending'),
      deps.scanLedger.countByEventAndStatus(eventId, 'revoked'),
      deps.scanLedger.countByEventAndStatus(eventId, 'overridden'),
      deps.scanLedger.countByEventAndStatus(eventId, 'expired'),
      deps.scanLedger.countByEventAndStatus(eventId, 'cancelled'),
      deps.doorSales.getEventStats(eventId),
      deps.coverWallets.getEventStats(eventId),
      deps.scanLedger.getAdmissionStats(eventId, tierNames),
      // Door sales admit their whole party, not one person per sale, so
      // headcount comes from `totalGuests` rather than from the sale count.
      deps.doorSales.findByEvent(eventId, { cursor: null, limit: 1000 }),
    ]);

    const doorHeadcount = doorSalesPage.items
      .filter((sale) => sale.status === 'active')
      .reduce((sum, sale) => sum + sale.totalGuests, 0);
    const inside = admissions.admitted + doorHeadcount;
    const byEntryType = { ...admissions.byEntryType };
    // Admissions against a tier that has since been renamed or removed. Kept
    // visible so the categories always sum to the headcount.
    if (admissions.unattributed > 0) byEntryType.other = admissions.unattributed;
    for (const sale of doorSalesPage.items) {
      if (sale.status !== 'active') continue;
      const key = sale.category === 'dinein' ? 'dine-in' : 'walk-in';
      byEntryType[key] = (byEntryType[key] ?? 0) + sale.totalGuests;
    }

    return {
      eventId,
      occupancy: {
        inside,
        capacity: event.capacity,
        remaining: event.capacity === null ? null : Math.max(0, event.capacity - inside),
        prebooked: admissions.admitted,
        doorEntries: doorHeadcount,
      },
      byEntryType,
      scans: {
        total: consumed + denied + pending + revoked + overridden + expired + cancelled,
        consumed,
        denied,
        pending,
        revoked,
        overridden,
        expired,
        cancelled,
      },
      doorSales: {
        count: doorStats.totalSales,
        grossPaise: doorStats.totalRevenue,
      },
      coverWallet: {
        activeWallets: walletStats.activeWallets,
        totalBalancePaise: walletStats.totalBalance,
        totalCreditsPaise: walletStats.totalCredits,
        totalDebitsPaise: walletStats.totalDebits,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  return { getStats };
}
