import { ForbiddenError, InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { canSessionCharge } from '../../domain/models/event-code.js';
import { requireOrgAccess } from '../context.js';

import type { DoorStats, DoorStatsService } from './door-stats-service.js';
import type { EntityId } from '../../domain/identity.js';
import type { DoorSale } from '../../domain/models/door-sale.js';
import type { Entitlement } from '../../domain/models/entitlement.js';
import type { TicketTier } from '../../domain/models/event-catalog.js';
import type { SessionPermissions } from '../../domain/models/event-code.js';
import type { Event } from '../../domain/models/event.js';
import type { ScanLedger } from '../../domain/models/scan-ledger.js';
import type { Page } from '../../domain/ports/repositories.js';
import type { ServiceDeps, ActorContext } from '../context.js';
import type { CoverWalletService, WalletChargeView } from '../cover-wallet/cover-wallet-service.js';
import type { OpenScannerSessionCommand, ScannerService } from '../scanner/scanner-service.js';

/**
 * ─── Door operations (Phase 5) ──────────────────────────────────────────────
 *
 * The screens a door device sees that are not the camera: pick tonight's
 * event, start a shift, work the guest list, check someone in by hand.
 *
 * It is its own service rather than more methods on `ScannerService` because
 * these are *compositions* — starting a shift is a session plus the event's
 * tiers plus an opening stats snapshot, and a guest list is entitlements
 * merged with door sales. `ScannerService` owns the admission decision and
 * should not grow a dependency on the ticket catalog to do it.
 *
 * Everything here is tenant-scoped through the event, so two clubs running
 * two events on the same night never see each other's rosters.
 */

export interface DoorOpsServiceDeps {
  scanner: ScannerService;
  coverWallet: CoverWalletService;
  doorStats: DoorStatsService;
  events: ServiceDeps['repositories']['events'];
  catalog: ServiceDeps['repositories']['catalog'];
  entitlements: ServiceDeps['repositories']['entitlements'];
  eventCodes: ServiceDeps['repositories']['eventCodes'];
  doorSales: ServiceDeps['repositories']['doorSales'];
  scanLedger: ServiceDeps['repositories']['scanLedger'];
  adminAudit: ServiceDeps['adminAudit'];
  logger: ServiceDeps['logger'];
}

/** A tonight's-events row. Deliberately small — this is a picker, not a page. */
export interface DoorEventSummary {
  id: EntityId;
  title: string;
  slug: string;
  venueId: EntityId | null;
  startAt: string;
  endAt: string | null;
  status: Event['status'];
  capacity: number | null;
}

export interface DoorTierSummary {
  id: EntityId;
  name: string;
  entryType: string;
  pricePaise: number;
  /** Live sellable quantity, for the door-sale screen. */
  available: number;
}

export interface StartShiftResult {
  sessionId: EntityId;
  sessionToken: string;
  sessionExpiresAt: string;
  event: DoorEventSummary;
  permissions: SessionPermissions;
  gate: string | null;
  tiers: DoorTierSummary[];
  stats: DoorStats;
  device: { deviceId: string; deviceName: string };
}

export type DoorGuestSource = 'online' | 'door';

export interface DoorGuest {
  /** Entitlement id for an online ticket; door-sale id for a door guest. */
  id: EntityId;
  name: string;
  ticketType: string;
  entryType: string;
  /** People this row admits (a couple ticket is one row admitting 2). */
  quantity: number;
  source: DoorGuestSource;
  status: 'entered' | 'not_entered';
  enteredAt: string | null;
  /** Only present for online tickets — door guests are entered by definition. */
  scansUsed: number | null;
  scansAllowed: number | null;
}

export interface ResolveWalletCommand {
  sessionToken: string;
  eventId: EntityId;
  qrPayload: string;
}

export interface ChargeWalletCommand {
  sessionToken: string;
  eventId: EntityId;
  /** The scanned tab QR — a charge always follows a live scan, never an id. */
  qrPayload: string;
  presetItemId: EntityId;
  quantity: number;
  idempotencyKey: string;
}

export interface WalletChargeResult {
  wallet: WalletChargeView;
  charged: { itemId: EntityId; label: string; quantity: number; amountPaise: number };
  balancePaise: number;
}

export interface DoorGuestQuery {
  /** Narrow to who is still outside, who is in, or who was sold at the door. */
  status?: 'entered' | 'not_entered';
  source?: DoorGuestSource;
  /** Case-insensitive name match, applied server-side. */
  search?: string;
  limit?: number;
}

export interface DoorGuestPage {
  items: DoorGuest[];
  /**
   * True when the roster was larger than this service is willing to scan.
   * Surfaced rather than silently cut: door staff searching for a name need
   * to know the answer "not found" might mean "not looked at".
   */
  truncated: boolean;
}

export interface DoorOpsService {
  resolveWallet(command: ResolveWalletCommand, actor: ActorContext): Promise<WalletChargeView>;
  chargeWallet(command: ChargeWalletCommand, actor: ActorContext): Promise<WalletChargeResult>;
  listEvents(dateSpec: string, actor: ActorContext): Promise<DoorEventSummary[]>;
  startShift(command: OpenScannerSessionCommand, actor: ActorContext): Promise<StartShiftResult>;
  listGuests(eventId: EntityId, query: DoorGuestQuery, actor: ActorContext): Promise<DoorGuestPage>;
  manualCheckIn(
    eventId: EntityId,
    entitlementId: EntityId,
    actor: ActorContext,
  ): Promise<{ guest: DoorGuest; scan: ScanLedger }>;
}

/**
 * India Standard Time, fixed offset, no DST. "Tonight's events" must mean the
 * venue's night, not UTC's — an 11pm show on the 4th is a UTC-5th event, and a
 * door device asking for "today" at 1am is still working the previous night.
 */
const IST_OFFSET_MINUTES = 5 * 60 + 30;

/**
 * Bounds on the roster read. These are not arbitrary: a door phone cannot
 * render more than a few hundred rows, and an unbounded scan of a festival's
 * entitlements is a way to exhaust the gateway's memory with one request.
 * Filtering and searching therefore happen server-side, and anything past the
 * scan cap is reported as `truncated` rather than quietly dropped.
 */
const MAX_GUEST_PAGE = 1000;
const GUEST_SCAN_PAGE = 500;
const MAX_GUEST_SCAN = 20_000;
const MAX_DOOR_SALE_SCAN = 2_000;

/**
 * How many pages of an organization's events the picker will walk looking for
 * tonight's. Events have no date index, so this is a scan; the cap keeps one
 * request from reading a venue's entire history.
 */
const MAX_EVENT_SCAN_PAGES = 10;

function guestMatches(guest: DoorGuest, query: DoorGuestQuery, search?: string): boolean {
  if (query.status && guest.status !== query.status) return false;
  if (query.source && guest.source !== query.source) return false;
  if (search && !guest.name.toLowerCase().includes(search)) return false;
  return true;
}

function istDateKey(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + IST_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** Accepts `today` or `YYYY-MM-DD`; anything else is a caller error, not a guess. */
export function resolveDoorDate(dateSpec: string, now = new Date()): string {
  if (dateSpec === 'today') return istDateKey(now.toISOString());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateSpec)) {
    throw new InvalidOperationError('date must be `today` or YYYY-MM-DD');
  }
  return dateSpec;
}

export function createDoorOpsService(deps: DoorOpsServiceDeps): DoorOpsService {
  // ── Cover wallet at the door ──────────────────────────────────────────────

  /**
   * A tab can only be touched by a device holding a live scanner session with
   * the `charge` permission — a `scan_only` handset at the entrance must not
   * be able to ring up drinks, which is the entire reason door codes have
   * types.
   */
  async function requireChargeSession(
    sessionToken: string,
    eventId: EntityId,
    actor: ActorContext,
  ) {
    const event = await deps.events.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    requireOrgAccess(actor, event.organizationId);

    const session = await deps.scanner.authenticateSession(sessionToken, eventId);
    requireOrgAccess(actor, session.organizationId);
    if (!canSessionCharge(session)) {
      throw new ForbiddenError('This scanner session may not charge cover wallets');
    }
    return session;
  }

  /**
   * Reads a scanned tab. Deliberately returns the charge view rather than the
   * wallet: a bartender needs who, how much, and what is on the list — not
   * the guest's id, metadata or transaction history.
   */
  async function resolveWallet(
    command: ResolveWalletCommand,
    actor: ActorContext,
  ): Promise<WalletChargeView> {
    await requireChargeSession(command.sessionToken, command.eventId, actor);

    const walletId = deps.coverWallet.verifyWalletQr(command.qrPayload);
    // A forged or stale tab QR is refused outright. It is never treated as a
    // bare wallet id, which is how a signature check gets quietly bypassed.
    if (!walletId) throw new InvalidOperationError('That QR code could not be verified');

    const view = await deps.coverWallet.getChargeView(walletId, actor);
    // A tab from another event at the same venue is not this door's business.
    if (view.eventId !== command.eventId) {
      throw new InvalidOperationError('That tab belongs to a different event');
    }
    return view;
  }

  /**
   * Charges one preset item. The scanner names an item; the price comes from
   * the venue's own list inside `chargePreset`. Re-scanning is required (the
   * command carries the QR, not a wallet id) so a charge always follows a tab
   * physically presented at the bar.
   */
  async function chargeWallet(
    command: ChargeWalletCommand,
    actor: ActorContext,
  ): Promise<WalletChargeResult> {
    const session = await requireChargeSession(command.sessionToken, command.eventId, actor);

    const walletId = deps.coverWallet.verifyWalletQr(command.qrPayload);
    if (!walletId) throw new InvalidOperationError('That QR code could not be verified');

    const before = await deps.coverWallet.getChargeView(walletId, actor);
    if (before.eventId !== command.eventId) {
      throw new InvalidOperationError('That tab belongs to a different event');
    }

    const result = await deps.coverWallet.chargePreset(
      {
        walletId,
        presetItemId: command.presetItemId,
        quantity: command.quantity,
        idempotencyKey: command.idempotencyKey,
        ...(session.deviceId === null ? {} : { deviceId: session.deviceId }),
      },
      actor,
    );

    return {
      wallet: await deps.coverWallet.getChargeView(walletId, actor),
      charged: {
        itemId: result.item.id,
        label: result.item.label,
        quantity: command.quantity,
        amountPaise: result.item.amountPaise * command.quantity,
      },
      balancePaise: result.wallet.balance,
    };
  }

  async function listEvents(dateSpec: string, actor: ActorContext): Promise<DoorEventSummary[]> {
    const day = resolveDoorDate(dateSpec);
    const collected: Event[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await deps.events.listByOrganization(actor.organizationId, {
        cursor,
        limit: 200,
      });
      collected.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < MAX_EVENT_SCAN_PAGES);

    return (
      collected
        .filter((event) => istDateKey(event.startAt) === day)
        // Drafts are not doors. A draft has no tickets sold against it, so
        // opening a shift on one could only ever produce denials.
        .filter((event) => event.status !== 'draft' && event.status !== 'cancelled')
        .sort((a, b) => (a.startAt < b.startAt ? -1 : 1))
        .map(toEventSummary)
    );
  }

  async function startShift(
    command: OpenScannerSessionCommand,
    actor: ActorContext,
  ): Promise<StartShiftResult> {
    const event = await deps.events.findById(command.eventId);
    if (!event) throw new NotFoundError('Event', command.eventId);
    requireOrgAccess(actor, event.organizationId);

    // Authorize the handset first: a session minted for a device the venue
    // then refuses would be a token that looks valid and scans nothing.
    await deps.scanner.bindDevice(
      {
        deviceId: command.deviceId,
        deviceName: command.deviceName,
        venueId: event.venueId,
      },
      actor,
    );

    const opened = await deps.scanner.openSession(command, actor);
    const [tiers, stats, code] = await Promise.all([
      deps.catalog.listTiers(event.id),
      deps.doorStats.getStats(event.id, actor),
      deps.eventCodes.findById(opened.session.codeId),
    ]);

    return {
      sessionId: opened.sessionId,
      sessionToken: opened.sessionToken,
      sessionExpiresAt: opened.sessionExpiresAt,
      event: toEventSummary(event),
      permissions: opened.session.permissions,
      // A gate-restricted code tells the device which gate it is on rather
      // than letting it choose; an unrestricted code reports null and the
      // operator's own gate label is used per scan.
      gate: code?.gate ?? null,
      tiers: tiers.filter((t) => t.status === 'active').map(toTierSummary),
      stats,
      device: { deviceId: command.deviceId, deviceName: command.deviceName },
    };
  }

  /**
   * The merged roster: everyone who bought online, plus everyone sold at the
   * door tonight.
   *
   * Entered-ness comes from the entitlement's own `scanCount`, not from the
   * scan ledger — the ledger records attempts (including denials and
   * overrides), while the entitlement records what was actually spent. Reading
   * the ledger here would show a guest as "entered" because someone tried.
   */
  async function listGuests(
    eventId: EntityId,
    query: DoorGuestQuery,
    actor: ActorContext,
  ): Promise<DoorGuestPage> {
    const event = await deps.events.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    requireOrgAccess(actor, event.organizationId);

    const limit = Math.min(Math.max(query.limit ?? 200, 1), MAX_GUEST_PAGE);
    const search = query.search?.trim().toLowerCase();

    // Filtering happens here, not on the phone. An earlier version paged every
    // entitlement for the event into memory and shipped the lot; for a
    // festival that is both an out-of-memory risk on the server and tens of
    // thousands of guest names crossing the wire to a device in a car park.
    const matches: DoorGuest[] = [];
    let scanned = 0;
    let truncated = false;
    let cursor: string | null = null;
    do {
      const page: Page<Entitlement> = await deps.entitlements.listByEvent(eventId, {
        cursor,
        limit: GUEST_SCAN_PAGE,
      });
      for (const entitlement of page.items) {
        const guest = toOnlineGuest(entitlement);
        if (guestMatches(guest, query, search)) matches.push(guest);
      }
      scanned += page.items.length;
      cursor = page.nextCursor;
      if (scanned >= MAX_GUEST_SCAN && cursor !== null) {
        truncated = true;
        break;
      }
    } while (cursor);

    if (query.source !== 'online') {
      const doorSales = await deps.doorSales.findByEvent(eventId, {
        cursor: null,
        limit: MAX_DOOR_SALE_SCAN,
      });
      for (const sale of doorSales.items) {
        if (sale.status !== 'active') continue;
        const guest = toDoorGuest(sale);
        if (guestMatches(guest, query, search)) matches.push(guest);
      }
      if (doorSales.nextCursor !== null) truncated = true;
    }

    // Not-entered first — the list exists to find people who have not come in
    // yet — then alphabetical so a name is findable by eye.
    matches.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'not_entered' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return {
      items: matches.slice(0, limit),
      truncated: truncated || matches.length > limit,
    };
  }

  /**
   * Admits a guest whose QR will not scan — a cracked screen, a dead phone, a
   * ticket forwarded as a screenshot of a screenshot.
   *
   * Runs the SAME atomic claim as a camera scan, so a manual check-in cannot
   * be used to get past a ticket that is already spent or voided, and cannot
   * race a scanner at another door.
   */
  async function manualCheckIn(
    eventId: EntityId,
    entitlementId: EntityId,
    actor: ActorContext,
  ): Promise<{ guest: DoorGuest; scan: ScanLedger }> {
    const event = await deps.events.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    requireOrgAccess(actor, event.organizationId);

    const claim = await deps.entitlements.claimAdmission(entitlementId, eventId);
    if (!claim.admitted) {
      throw new InvalidOperationError(claim.denyMessage ?? 'This ticket cannot be checked in');
    }
    const entitlement = claim.entitlement;
    if (!entitlement) throw new NotFoundError('Ticket', entitlementId);

    const scan = await deps.scanLedger.create({
      eventId,
      organizationId: event.organizationId,
      venueId: event.venueId,
      entitlementId,
      doorSaleId: null,
      entryType: 'ticket',
      tierName: entitlement.tierName,
      tierId: entitlement.tierId,
      operatorUid: actor.userId,
      operatorName: null,
      operatorRole: null,
      gate: null,
      // No device: this came from a manager's own screen, not a scanner. The
      // ledger says so rather than borrowing some device's identity.
      deviceId: null,
      deviceName: 'manual check-in',
      deviceBound: false,
      guestName: entitlement.holderName,
      guestEmail: null,
      guestPhone: null,
      scannedAt: new Date().toISOString(),
      admittedCount: 1,
      scanCountUsed: claim.scansUsed,
      scanCountAllowed: claim.scansAllowed,
      isOffline: false,
      offlineDeviceId: null,
      status: 'consumed',
    });

    await deps.adminAudit.write({
      id: `audit-manual-${scan.id}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: event.organizationId,
      action: 'door.manual_check_in',
      targetType: 'scan_ledger',
      targetId: scan.id,
      after: { entitlementId, scansUsed: claim.scansUsed },
    });

    return { guest: toOnlineGuest(entitlement), scan };
  }

  return { resolveWallet, chargeWallet, listEvents, startShift, listGuests, manualCheckIn };
}

function toEventSummary(event: Event): DoorEventSummary {
  return {
    id: event.id,
    title: event.title,
    slug: event.slug,
    venueId: event.venueId,
    startAt: event.startAt,
    endAt: event.endAt,
    status: event.status,
    capacity: event.capacity,
  };
}

function toTierSummary(tier: TicketTier): DoorTierSummary {
  return {
    id: tier.id,
    name: tier.name,
    entryType: tier.entryType,
    pricePaise: tier.priceInPaise,
    available: tier.quantity,
  };
}

function toOnlineGuest(entitlement: Entitlement): DoorGuest {
  const entered = entitlement.scanCount > 0;
  return {
    id: entitlement.id,
    name: entitlement.holderName,
    ticketType: entitlement.tierName,
    entryType: entitlement.scanCountAllowed > 1 ? 'couple' : 'general',
    quantity: entitlement.scanCountAllowed,
    source: 'online',
    status: entered ? 'entered' : 'not_entered',
    enteredAt: entitlement.scannedAt[entitlement.scannedAt.length - 1] ?? null,
    scansUsed: entitlement.scanCount,
    scansAllowed: entitlement.scanCountAllowed,
  };
}

function toDoorGuest(sale: DoorSale): DoorGuest {
  return {
    id: sale.id,
    name: sale.guestName,
    ticketType: sale.category === 'dinein' ? 'Dine-in' : 'Walk-in',
    entryType: sale.category,
    quantity: sale.totalGuests,
    source: 'door',
    // A door sale IS an entry — the guest is standing there paying.
    status: 'entered',
    enteredAt: sale.createdAt,
    scansUsed: null,
    scansAllowed: null,
  };
}
