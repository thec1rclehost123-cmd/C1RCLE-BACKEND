import { NotFoundError } from '../../domain/errors.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type {
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
  scanLedger: ScanLedgerRepository;
  doorSales: DoorSaleRepository;
  coverWallets: CoverWalletRepository;
}

export interface DoorStats {
  eventId: EntityId;
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
    ]);

    return {
      eventId,
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
