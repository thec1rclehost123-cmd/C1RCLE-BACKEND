import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  DeviceNotAuthorizedError,
  InvalidOperationError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../domain/errors.js';
import { evaluateAdmission } from '../../domain/models/entitlement.js';
import {
  isSessionValid,
  canSessionScan,
  hashSessionToken,
} from '../../domain/models/event-code.js';
import {
  bindScannerDevice,
  isDeviceAuthorized,
  rebindScannerDevice,
  scannerDeviceId,
  unbindScannerDevice,
} from '../../domain/models/scanner-device.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { Entitlement } from '../../domain/models/entitlement.js';
import type {
  EventCode,
  EventCodeCreateInput,
  ScannerSession,
  ScannerSessionType,
} from '../../domain/models/event-code.js';
import type {
  ScanLedger,
  ScanLedgerCreateInput,
  ScanDenyReason,
} from '../../domain/models/scan-ledger.js';
import type { ScannerDevice } from '../../domain/models/scanner-device.js';
import type { Page, PaginationQuery } from '../../domain/ports/repositories.js';
import type { ServiceDeps, ActorContext } from '../context.js';

/**
 * ─── Scanner Service (Phase 5) ──────────────────────────────────────────────
 *
 * Everything the door app does: mint and revoke the codes that authorize a
 * scanner, open and close device sessions, resolve a QR, and admit (or
 * refuse) a guest.
 *
 * Three security properties hold here and are worth stating plainly, because
 * each replaced an earlier version that did not have it:
 *
 *  1. **A scan is authenticated twice.** The Better Auth session says *who*
 *     the operator is and which tenant they act for; the scanner-session
 *     token (`X-Scanner-Session-Token`, minted once by `POST /door/sessions`)
 *     says *which device on which shift at which event*. Neither alone is
 *     enough. The previous scheme trusted a `deviceId` string supplied in the
 *     request body — a value any caller could type — which meant the session
 *     permission model (`full` / `scan_only` / `charge`) was advisory.
 *  2. **Admission is claimed atomically, never checked-then-written.** The
 *     service does not read an entitlement, decide, and save. It calls
 *     `entitlements.claimAdmission`, which performs the whole decision inside
 *     one Firestore transaction. Two scanners at two doors presenting the
 *     same QR simultaneously therefore cannot both be admitted.
 *  3. **Cross-tenant answers are indistinguishable.** A ticket belonging to
 *     another club is `wrong_event` with no state disclosed — a scanner at
 *     venue B cannot use denial reasons to learn whether a venue-A ticket is
 *     valid, refunded, or spent.
 *
 * No `process.env`, no Firebase, no HTTP in this layer.
 */

export interface ScannerServiceDeps {
  scanLedger: ServiceDeps['repositories']['scanLedger'];
  eventCodes: ServiceDeps['repositories']['eventCodes'];
  scannerSessions: ServiceDeps['repositories']['scannerSessions'];
  scannerDevices: ServiceDeps['repositories']['scannerDevices'];
  entitlements: ServiceDeps['repositories']['entitlements'];
  repositories: ServiceDeps['repositories'];
  config: ServiceDeps['config'];
  logger: ServiceDeps['logger'];
  outbox: ServiceDeps['outbox'];
  adminAudit: ServiceDeps['adminAudit'];
}

/** What a manager sends to mint a door code (org/event resolved server-side). */
export interface CreateEventCodeCommand {
  eventId: EntityId;
  type: EventCode['type'];
  gate: string | null;
  maxDevices?: number;
  allowReuse?: boolean;
  expiresAt: string | null;
}

/** What a device sends to open a shift. */
export interface OpenScannerSessionCommand {
  eventId: EntityId;
  code: string;
  deviceId: string;
  deviceName: string;
  sessionType: ScannerSessionType;
}

export interface OpenScannerSessionResult {
  session: ScannerSession;
  sessionToken: string;
  sessionExpiresAt: string;
  sessionId: string;
}

export interface ScannerService {
  // ── Door-code management (manager side) ──────────────────────────────────
  createEventCode(command: CreateEventCodeCommand, actor: ActorContext): Promise<EventCode>;
  listEventCodes(eventId: EntityId, actor: ActorContext): Promise<EventCode[]>;
  revokeEventCode(codeId: EntityId, reason: string, actor: ActorContext): Promise<EventCode>;
  listSessionsForCode(
    codeId: EntityId,
    query: PaginationQuery,
    actor: ActorContext,
  ): Promise<Page<ScannerSession>>;

  // ── Session lifecycle (device side) ──────────────────────────────────────
  openSession(
    command: OpenScannerSessionCommand,
    actor: ActorContext,
  ): Promise<OpenScannerSessionResult>;
  /** Resolves a raw session token to its session, or throws `UnauthorizedError`. */
  authenticateSession(token: string, eventId: EntityId): Promise<ScannerSession>;
  getSession(sessionId: EntityId, actor: ActorContext): Promise<ScannerSession>;
  revokeSession(sessionId: EntityId, reason: string, actor: ActorContext): Promise<ScannerSession>;

  // ── Scanning ─────────────────────────────────────────────────────────────
  scan(input: ScanInput, actor: ActorContext): Promise<ScanResult>;
  resolve(input: ResolveInput, actor: ActorContext): Promise<TicketResolution>;
  getScan(checkInId: EntityId, actor: ActorContext): Promise<ScanLedger>;
  overrideScan(checkInId: EntityId, reason: string, actor: ActorContext): Promise<ScanLedger>;
  generateMagicTicketQr(
    ticketId: EntityId,
    actor: ActorContext,
  ): Promise<{ qrPayload: string; expiresAt: string; refreshIntervalSec: number }>;

  // ── Devices ──────────────────────────────────────────────────────────────
  bindDevice(command: BindDeviceCommand, actor: ActorContext): Promise<ScannerDevice>;
  /** `door.manage` only — see `bindDevice` for why this is separate. */
  reauthorizeDevice(
    deviceId: string,
    deviceName: string,
    actor: ActorContext,
  ): Promise<ScannerDevice>;
  heartbeat(command: HeartbeatCommand, actor: ActorContext): Promise<ScannerDevice>;
  listDevices(query: PaginationQuery, actor: ActorContext): Promise<Page<ScannerDevice>>;
  unbindDevice(deviceId: string, reason: string, actor: ActorContext): Promise<ScannerDevice>;

  // ── Couple tickets (two-step admission) ──────────────────────────────────
  confirmCouple(command: ConfirmCoupleCommand, actor: ActorContext): Promise<ScanResult>;

  // ── Audit ────────────────────────────────────────────────────────────────
  recordStaffDeny(command: StaffDenyCommand, actor: ActorContext): Promise<ScanLedger>;

  // ── Offline ──────────────────────────────────────────────────────────────
  buildOfflineManifest(
    eventId: EntityId,
    sessionToken: string,
    actor: ActorContext,
  ): Promise<OfflineManifest>;
  syncOfflineScans(input: OfflineSyncInput, actor: ActorContext): Promise<OfflineSyncResult>;
}

/**
 * One scan request. `qrPayload` is whatever the camera read — the service
 * decides whether it is a rotating "magic" payload or a bare ticket id, so a
 * caller can never steer that choice.
 */
export interface ScanInput {
  eventId: EntityId;
  qrPayload: string;
  /** Raw scanner-session token from `X-Scanner-Session-Token`. */
  sessionToken: string;
  /** Display label only — the authoritative operator is `actor.userId`. */
  operatorName?: string;
  operatorRole?: string;
  /** Ignored when the code is gate-restricted; the code's gate wins. */
  gate?: string;
  scannedAt?: string;
}

export interface BindDeviceCommand {
  deviceId: string;
  deviceName: string;
  venueId?: EntityId | null;
}

export interface HeartbeatCommand {
  sessionToken: string;
  eventId: EntityId;
  gate?: string;
}

export interface ConfirmCoupleCommand {
  confirmationToken: string;
  sessionToken: string;
  eventId: EntityId;
  /** `false` = staff looked, only one guest is present, refuse the pair. */
  confirmed: boolean;
  operatorName?: string;
  operatorRole?: string;
  gate?: string;
}

export interface StaffDenyCommand {
  sessionToken: string;
  eventId: EntityId;
  /** What was scanned, so the row can be tied back to a ticket if it parses. */
  qrPayload?: string;
  reason: string;
  gate?: string;
}

export interface ResolveInput {
  eventId: EntityId;
  qrPayload: string;
  sessionToken: string;
}

/**
 * The verdict of a non-consuming lookup. `status: 'valid'` means the ticket
 * WOULD be admitted right now. Nothing is persisted — a preview must never
 * spend an admission, and must never be mistakable for one, which is why it
 * carries no `checkInId`.
 */
export interface TicketResolution {
  status: 'valid' | 'invalid';
  denyReason: ScanDenyReason | null;
  denyMessage: string | null;
  entitlement?: TicketSummary;
}

export interface TicketSummary {
  id: EntityId;
  tierName: string;
  tierId: EntityId;
  holderName: string;
  scansUsed: number;
  scansAllowed: number;
  status: string;
}

export interface ScanResult {
  /**
   * `null` only on `confirmation_required`: nothing is written while the door
   * waits for a human, so there is no ledger row to point at yet.
   */
  scan: ScanLedger | null;
  status: 'consumed' | 'denied' | 'confirmation_required';
  denyReason?: ScanDenyReason;
  denyMessage?: string;
  entitlement?: TicketSummary;
  /**
   * Present only on `confirmation_required`. Short-lived, signed, and bound to
   * this ticket, this session, this device and the exact scan count the staff
   * member was shown — so it cannot be replayed, moved to another door, or
   * used after something else consumed a seat.
   */
  confirmation?: {
    token: string;
    expiresAt: string;
    seats: number;
  };
}

export interface OfflineManifestEntry {
  entitlementId: EntityId;
  validFrom: string;
  validTo: string;
  signature: string;
}

export interface OfflineManifest {
  manifest: OfflineManifestEntry[];
  signedAt: string;
  expiresAt: string;
}

export interface OfflineSyncInput {
  sessionToken: string;
  eventId: EntityId;
  scans: { payload: string; scannedAt: string; deviceId: string }[];
}

export interface OfflineSyncResult {
  synced: number;
  conflicts: { payload: string; reason: string }[];
}

/** Rotating-QR window. Both sides of ±1 window are accepted (±65s of drift). */
const MAGIC_WINDOW_SEC = 30;
/** An offline manifest is a short-lived pre-authorization, not a licence. */
const OFFLINE_MANIFEST_TTL_MS = 12 * 60 * 60 * 1000;
/**
 * How long staff have to answer "are both guests here?". Long enough to look
 * up from the phone and count two people; short enough that a token screenshot
 * taken at the door is worthless by the time anyone could reuse it.
 */
const COUPLE_CONFIRMATION_TTL_MS = 30 * 1000;

function createScannerServiceImpl(deps: ScannerServiceDeps): ScannerService {
  const {
    scanLedger,
    eventCodes,
    scannerSessions,
    scannerDevices,
    entitlements,
    config,
    adminAudit,
  } = deps;

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Event lookup + tenant check, in that order, for every door operation. */
  async function requireEvent(eventId: EntityId, actor: ActorContext) {
    const event = await deps.repositories.events.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    requireOrgAccess(actor, event.organizationId);
    return event;
  }

  async function requireCode(codeId: EntityId, actor: ActorContext): Promise<EventCode> {
    const code = await eventCodes.findById(codeId);
    if (!code) throw new NotFoundError('Event code', codeId);
    requireOrgAccess(actor, code.organizationId);
    return code;
  }

  function hmacHex(message: string): string {
    return createHmac('sha256', config.magicTicketSecret).update(message).digest('hex');
  }

  /**
   * Constant-time comparison. A plain `===` on an HMAC leaks, through timing,
   * how many leading bytes an attacker guessed right — which turns forging a
   * ticket signature from a 2^256 problem into a per-byte one.
   */
  function hmacMatches(candidate: string, expected: string): boolean {
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * The device check every scan runs.
   *
   * A session says "this shift, this event"; a binding says "this venue owns
   * this handset". Both are required. A device that was unbound mid-shift
   * (lost, stolen, or handed back) stops working immediately even though its
   * session token is still cryptographically valid — which is the whole
   * reason the binding is a separate record from the session.
   */
  async function requireBoundDevice(session: ScannerSession): Promise<ScannerDevice> {
    const deviceId = session.deviceId;
    if (deviceId === null || deviceId.length === 0) {
      throw new DeviceNotAuthorizedError('This scanner session is not bound to a device');
    }
    const device = await scannerDevices.findByDevice(session.organizationId, deviceId);
    if (!isDeviceAuthorized(device)) {
      throw new DeviceNotAuthorizedError();
    }
    return device;
  }

  /** Best-effort liveness. Never fails a scan — see the port's doc comment. */
  async function touchDevice(
    session: ScannerSession,
    patch: Parameters<ServiceDeps['repositories']['scannerDevices']['touch']>[1],
  ): Promise<void> {
    if (session.deviceId === null) return;
    try {
      await scannerDevices.touch(scannerDeviceId(session.organizationId, session.deviceId), patch);
    } catch (error) {
      deps.logger.warn('scanner_device_touch_failed', {
        deviceId: session.deviceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Mints the couple-confirmation token.
   *
   * Domain-separated from the ticket-QR HMAC by the `confirm:` prefix, so a
   * confirmation token can never be presented as a ticket or vice versa even
   * though both are signed with the same key. Everything the server will
   * re-check is inside the signed string — nothing is looked up from a
   * caller-supplied field at confirm time.
   */
  function mintConfirmationToken(args: {
    entitlementId: EntityId;
    eventId: EntityId;
    sessionId: EntityId;
    deviceId: string;
    expectedScansUsed: number;
    seats: number;
    expiresAtMs: number;
  }): string {
    const body = [
      args.entitlementId,
      args.eventId,
      args.sessionId,
      args.deviceId,
      String(args.expectedScansUsed),
      String(args.seats),
      String(args.expiresAtMs),
    ].join('|');
    return `${Buffer.from(body, 'utf8').toString('base64url')}.${hmacHex(`confirm:${body}`)}`;
  }

  interface ConfirmationClaims {
    entitlementId: EntityId;
    eventId: EntityId;
    sessionId: EntityId;
    deviceId: string;
    expectedScansUsed: number;
    seats: number;
    expiresAtMs: number;
  }

  function verifyConfirmationToken(token: string): ConfirmationClaims | null {
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) return null;
    let body: string;
    try {
      body = Buffer.from(encoded, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    if (!hmacMatches(signature, hmacHex(`confirm:${body}`))) return null;
    const parts = body.split('|');
    if (parts.length !== 7) return null;
    const [entitlementId, eventId, sessionId, deviceId, used, seats, expiresAt] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const expiresAtMs = Number.parseInt(expiresAt, 10);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return null;
    return {
      entitlementId,
      eventId,
      sessionId,
      deviceId,
      expectedScansUsed: Number.parseInt(used, 10),
      seats: Number.parseInt(seats, 10),
      expiresAtMs,
    };
  }

  /**
   * Decodes whatever the camera read into a ticket id.
   *
   * `entitlementId:window:hmac` (3 non-empty colon-separated parts) is the
   * rotating "magic ticket" format; opaque ids can never contain `:`
   * (`opaqueIdSchema`), so the two cases are mutually exclusive by
   * construction rather than by heuristic. An unverifiable magic payload
   * resolves to `null` — a forged signature must be a denial, never a
   * fall-through to the bare-id path, which is exactly how a signature check
   * gets bypassed.
   */
  function decodeQr(qrPayload: string): { entitlementId: EntityId | null; magic: boolean } {
    const parts = qrPayload.split(':');
    if (parts.length !== 3 || !parts.every((p) => p.length > 0)) {
      return { entitlementId: qrPayload, magic: false };
    }
    const [entitlementId, windowStr, signature] = parts as [string, string, string];
    const windowStart = Number.parseInt(windowStr, 10);
    if (!Number.isFinite(windowStart)) return { entitlementId: null, magic: true };
    const current = hmacMatches(signature, hmacHex(`${entitlementId}:${windowStart}`));
    const previous = hmacMatches(
      signature,
      hmacHex(`${entitlementId}:${windowStart - MAGIC_WINDOW_SEC}`),
    );
    if (!current && !previous) return { entitlementId: null, magic: true };
    // A signature that verifies for a window far in the past or future is a
    // replayed screenshot, not clock drift.
    const nowWindow = Math.floor(Date.now() / 1000 / MAGIC_WINDOW_SEC) * MAGIC_WINDOW_SEC;
    if (Math.abs(nowWindow - windowStart) > MAGIC_WINDOW_SEC * 2) {
      return { entitlementId: null, magic: true };
    }
    return { entitlementId, magic: true };
  }

  function ticketSummary(entitlement: Entitlement): TicketSummary {
    return {
      id: entitlement.id,
      tierName: entitlement.tierName,
      tierId: entitlement.tierId,
      holderName: entitlement.holderName,
      scansUsed: entitlement.scanCount,
      scansAllowed: entitlement.scanCountAllowed,
      status: entitlement.status,
    };
  }

  /**
   * Writes one ledger row. Every scan attempt — admitted or refused — lands
   * here: a door with no record of its refusals cannot answer "why was my
   * guest turned away", and that question is asked constantly.
   */
  async function recordScan(args: {
    eventId: EntityId;
    organizationId: EntityId;
    venueId: EntityId | null;
    session: ScannerSession;
    actor: ActorContext;
    input: {
      operatorName?: string;
      operatorRole?: string;
      gate?: string | null;
      scannedAt?: string;
    };
    entitlementId: EntityId | null;
    entitlement: Entitlement | null;
    admitted: boolean;
    denyReason: ScanDenyReason | null;
    denyMessage: string | null;
    scansUsed: number | null;
    scansAllowed: number | null;
    isOffline?: boolean;
    offlineDeviceId?: string | null;
    /** Overrides the default 1-per-admission (a confirmed couple admits 2). */
    admittedCount?: number;
  }): Promise<ScanLedger> {
    const gate = args.input.gate ?? null;
    const record: ScanLedgerCreateInput = {
      eventId: args.eventId,
      organizationId: args.organizationId,
      venueId: args.venueId,
      entitlementId: args.entitlementId,
      doorSaleId: null,
      entryType: args.entitlement ? 'ticket' : null,
      tierName: args.entitlement?.tierName ?? null,
      tierId: args.entitlement?.tierId ?? null,
      // Authoritative: the verified session actor, never a body field.
      operatorUid: args.actor.userId,
      operatorName: args.input.operatorName ?? null,
      operatorRole: args.input.operatorRole ?? null,
      gate,
      deviceId: args.session.deviceId,
      deviceName: args.session.deviceName,
      deviceBound: true,
      guestName: args.entitlement?.holderName ?? null,
      guestEmail: null,
      guestPhone: null,
      scannedAt: args.input.scannedAt ?? new Date().toISOString(),
      admittedCount: args.admitted ? (args.admittedCount ?? 1) : 0,
      scanCountUsed: args.scansUsed,
      scanCountAllowed: args.scansAllowed,
      isOffline: args.isOffline ?? false,
      offlineDeviceId: args.offlineDeviceId ?? null,
      status: args.admitted ? 'consumed' : 'denied',
      denyReason: args.denyReason,
      denyMessage: args.denyMessage,
    };
    return scanLedger.create(record);
  }

  /**
   * Door-code counters are a dashboard number, not an invariant. A failure
   * here must never turn a successful admission into an error the guest sees,
   * so it is logged and swallowed rather than propagated.
   */
  async function bumpCodeUsage(codeId: EntityId): Promise<void> {
    try {
      await eventCodes.incrementScanCount(codeId);
      await eventCodes.updateLastUsed(codeId);
    } catch (error) {
      deps.logger.warn('scanner_code_stats_update_failed', {
        codeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── door-code management ──────────────────────────────────────────────────

  async function createEventCode(
    command: CreateEventCodeCommand,
    actor: ActorContext,
  ): Promise<EventCode> {
    const event = await requireEvent(command.eventId, actor);
    const input: EventCodeCreateInput = {
      eventId: event.id,
      // Taken from the EVENT, not from the request: a caller cannot mint a
      // door code into somebody else's tenant by naming their org id.
      organizationId: event.organizationId,
      venueId: event.venueId,
      type: command.type,
      gate: command.gate,
      createdBy: actor.userId,
      createdByName: actor.userId,
      maxDevices: command.maxDevices,
      allowReuse: command.allowReuse,
      expiresAt: command.expiresAt,
    };
    const created = await eventCodes.create(input);
    await adminAudit.write({
      id: `audit-${created.id}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action: 'door_code.create',
      targetType: 'event_code',
      targetId: created.id,
      // The code string itself is the credential — never written to the audit
      // trail, which is read by more people than may open a door.
      after: { eventId: created.eventId, type: created.type, gate: created.gate },
    });
    return created;
  }

  async function listEventCodes(eventId: EntityId, actor: ActorContext): Promise<EventCode[]> {
    await requireEvent(eventId, actor);
    return eventCodes.findActiveByEvent(eventId);
  }

  async function revokeEventCode(
    codeId: EntityId,
    reason: string,
    actor: ActorContext,
  ): Promise<EventCode> {
    const code = await requireCode(codeId, actor);
    const updated = await eventCodes.revoke(codeId, reason);
    if (!updated) throw new NotFoundError('Event code', codeId);

    // Revoking a code must also close the shifts it opened, or a device that
    // already holds a token keeps scanning after the code is "revoked" —
    // which is the whole point of revoking it (a lost or stolen device).
    const live = await scannerSessions.findActiveByCode(codeId);
    for (const session of live) {
      await scannerSessions.revoke(session.id, `code revoked: ${reason}`);
      await eventCodes.adjustActiveSessions(codeId, -1);
    }

    await adminAudit.write({
      id: `audit-${codeId}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action: 'door_code.revoke',
      targetType: 'event_code',
      targetId: codeId,
      before: { status: code.status },
      after: { status: updated.status, reason, sessionsRevoked: live.length },
    });
    return updated;
  }

  async function listSessionsForCode(
    codeId: EntityId,
    query: PaginationQuery,
    actor: ActorContext,
  ): Promise<Page<ScannerSession>> {
    await requireCode(codeId, actor);
    return scannerSessions.findByCode(codeId, query);
  }

  // ── session lifecycle ─────────────────────────────────────────────────────

  async function openSession(
    command: OpenScannerSessionCommand,
    actor: ActorContext,
  ): Promise<OpenScannerSessionResult> {
    const code = await eventCodes.findByCode(command.code);
    // A wrong code and another tenant's code answer identically. Anything
    // else turns this endpoint into an oracle for guessing door codes across
    // the whole platform.
    if (!code || code.organizationId !== actor.organizationId) {
      throw new NotFoundError('Event code', command.code);
    }
    if (code.eventId !== command.eventId) {
      throw new NotFoundError('Event code', command.code);
    }
    if (code.status !== 'active') {
      throw new InvalidOperationError(`Event code is ${code.status}`);
    }
    if (code.expiresAt && new Date(code.expiresAt) < new Date()) {
      await eventCodes.updateStatus(code.id, 'expired');
      throw new InvalidOperationError('Event code has expired');
    }

    // Device cap is counted from live sessions, not from a stored counter: a
    // crashed device that never closed its session would otherwise burn a
    // slot forever, and a drifted counter would either lock the door staff
    // out or silently lift the cap.
    const live = await scannerSessions.findActiveByCode(code.id);
    const sameDevice = live.find((s) => s.deviceId === command.deviceId);
    if (sameDevice) {
      // Re-opening on the same physical device replaces the old shift rather
      // than consuming a second slot — a scanner app restart is routine.
      await scannerSessions.revoke(sameDevice.id, 'replaced by a new session on the same device');
      await eventCodes.adjustActiveSessions(code.id, -1);
    } else if (!code.allowReuse && live.length >= code.maxDevices) {
      throw new InvalidOperationError('Maximum devices already active for this door code');
    }

    const result = await scannerSessions.create({
      codeId: code.id,
      organizationId: code.organizationId,
      codeData: {
        id: code.id,
        code: code.code,
        eventId: code.eventId,
        venueId: code.venueId,
        type: code.type,
        gate: code.gate,
        maxDevices: code.maxDevices,
        allowReuse: code.allowReuse,
      },
      deviceId: command.deviceId,
      deviceName: command.deviceName,
      createdBy: actor.userId,
      createdByName: actor.userId,
      sessionType: command.sessionType,
    });

    await eventCodes.adjustActiveSessions(code.id, 1);
    await adminAudit.write({
      id: `audit-${result.sessionId}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action: 'scanner_session.open',
      targetType: 'scanner_session',
      targetId: result.sessionId,
      // Never the token.
      after: {
        eventId: result.session.eventId,
        deviceId: result.session.deviceId,
        permissions: result.session.permissions,
      },
    });
    return result;
  }

  async function authenticateSession(token: string, eventId: EntityId): Promise<ScannerSession> {
    if (!token) throw new UnauthorizedError('Scanner session token required');
    const session = await scannerSessions.findByTokenHash(hashSessionToken(token));
    // One message for every failure mode (unknown token, revoked, expired,
    // wrong event) — a scanner that can tell "expired" from "never existed"
    // is a scanner that can enumerate tokens.
    if (!session || !isSessionValid(session) || session.eventId !== eventId) {
      throw new UnauthorizedError('Scanner session is not valid for this event');
    }
    return session;
  }

  async function getSession(sessionId: EntityId, actor: ActorContext): Promise<ScannerSession> {
    const session = await scannerSessions.findById(sessionId);
    if (!session) throw new NotFoundError('Scanner session', sessionId);
    requireOrgAccess(actor, session.organizationId);
    return session;
  }

  async function revokeSession(
    sessionId: EntityId,
    reason: string,
    actor: ActorContext,
  ): Promise<ScannerSession> {
    const session = await getSession(sessionId, actor);
    const updated = await scannerSessions.revoke(sessionId, reason);
    if (!updated) throw new NotFoundError('Scanner session', sessionId);
    await eventCodes.adjustActiveSessions(session.codeId, -1);
    await adminAudit.write({
      id: `audit-${sessionId}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action: 'scanner_session.revoke',
      targetType: 'scanner_session',
      targetId: sessionId,
      before: { revokedAt: session.revokedAt },
      after: { revokedAt: updated.revokedAt, reason },
    });
    return updated;
  }

  // ── scanning ──────────────────────────────────────────────────────────────

  /**
   * The real admission. Order is load-bearing:
   * event → tenant → session → permission → gate → atomic claim → ledger.
   * The claim is last because everything before it is a reason to refuse
   * *without* spending an admission.
   */
  async function scan(input: ScanInput, actor: ActorContext): Promise<ScanResult> {
    const event = await requireEvent(input.eventId, actor);
    const session = await authenticateSession(input.sessionToken, input.eventId);
    // The session belongs to the code, the code to the org — re-checked here
    // so a token minted under one tenant can never be replayed under another.
    requireOrgAccess(actor, session.organizationId);
    if (!canSessionScan(session)) {
      throw new ForbiddenError('This scanner session may not scan tickets');
    }

    await requireBoundDevice(session);

    const code = await eventCodes.findById(session.codeId);
    // A gate-restricted code pins the gate; a free code takes the operator's.
    const gate = code?.gate ?? input.gate;
    if (code?.gate && input.gate && input.gate !== code.gate) {
      throw new ForbiddenError('This scanner session is restricted to a different gate');
    }

    const scanArgs = {
      eventId: event.id,
      organizationId: event.organizationId,
      venueId: event.venueId,
      session,
      actor,
      input: { ...input, gate },
    };

    const decoded = decodeQr(input.qrPayload);
    if (!decoded.entitlementId) {
      const scanRecord = await recordScan({
        ...scanArgs,
        entitlementId: null,
        entitlement: null,
        admitted: false,
        denyReason: 'invalid_signature',
        denyMessage: 'QR code could not be verified',
        scansUsed: null,
        scansAllowed: null,
      });
      await bumpCodeUsage(session.codeId);
      return {
        scan: scanRecord,
        status: 'denied',
        denyReason: 'invalid_signature',
        denyMessage: 'QR code could not be verified',
      };
    }

    // ── Couple gate ────────────────────────────────────────────────────────
    // A couple ticket admits two people and both must walk through together.
    // Consuming a seat now, before staff have confirmed the second guest is
    // actually present, would strand that guest outside holding a ticket the
    // system says is half-used. So an untouched couple ticket stops here and
    // asks — and NOTHING is written, because a question is not an admission.
    const preview = await entitlements.findById(decoded.entitlementId);
    if (
      preview &&
      preview.eventId === event.id &&
      preview.status !== 'void' &&
      preview.scanCountAllowed === 2 &&
      preview.scanCount === 0 &&
      session.deviceId !== null
    ) {
      const expiresAtMs = Date.now() + COUPLE_CONFIRMATION_TTL_MS;
      return {
        scan: null,
        status: 'confirmation_required',
        entitlement: ticketSummary(preview),
        confirmation: {
          token: mintConfirmationToken({
            entitlementId: preview.id,
            eventId: event.id,
            sessionId: session.id,
            deviceId: session.deviceId,
            expectedScansUsed: preview.scanCount,
            seats: 2,
            expiresAtMs,
          }),
          expiresAt: new Date(expiresAtMs).toISOString(),
          seats: 2,
        },
      };
    }

    // THE atomic step. Everything this returns already accounts for every
    // concurrent scanner.
    const claim = await entitlements.claimAdmission(decoded.entitlementId, event.id);
    const entitlement = claim.entitlement;

    const scanRecord = await recordScan({
      ...scanArgs,
      entitlementId: decoded.entitlementId,
      // A wrong-event ticket belongs to another tenant: record the attempt,
      // but never copy that tenant's guest name onto this org's ledger.
      entitlement: claim.denyReason === 'wrong_event' ? null : entitlement,
      admitted: claim.admitted,
      denyReason: claim.denyReason,
      denyMessage: claim.denyMessage,
      scansUsed: claim.scansUsed,
      scansAllowed: claim.scansAllowed,
    });
    await bumpCodeUsage(session.codeId);
    await touchDevice(session, {
      lastSeenAt: new Date().toISOString(),
      lastEventId: event.id,
      lastGate: gate ?? null,
      lastScanAt: scanRecord.scannedAt,
      lastScanResult: claim.admitted ? 'consumed' : (claim.denyReason ?? 'denied'),
      incrementScanCount: true,
    });

    if (!claim.admitted) {
      return {
        scan: scanRecord,
        status: 'denied',
        ...(claim.denyReason ? { denyReason: claim.denyReason } : {}),
        ...(claim.denyMessage ? { denyMessage: claim.denyMessage } : {}),
        ...(entitlement && claim.denyReason !== 'wrong_event'
          ? { entitlement: ticketSummary(entitlement) }
          : {}),
      };
    }

    await adminAudit.write({
      id: `audit-${scanRecord.id}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: event.organizationId,
      action: 'door.scan_admitted',
      targetType: 'scan_ledger',
      targetId: scanRecord.id,
      after: {
        entitlementId: decoded.entitlementId,
        scansUsed: claim.scansUsed,
        scansAllowed: claim.scansAllowed,
      },
    });

    return {
      scan: scanRecord,
      status: 'consumed',
      ...(entitlement ? { entitlement: ticketSummary(entitlement) } : {}),
    };
  }

  /** Non-consuming preview — same rule, no write. */
  async function resolve(input: ResolveInput, actor: ActorContext): Promise<TicketResolution> {
    const event = await requireEvent(input.eventId, actor);
    const session = await authenticateSession(input.sessionToken, input.eventId);
    requireOrgAccess(actor, session.organizationId);
    if (!canSessionScan(session)) {
      throw new ForbiddenError('This scanner session may not scan tickets');
    }

    const decoded = decodeQr(input.qrPayload);
    if (!decoded.entitlementId) {
      return {
        status: 'invalid',
        denyReason: 'invalid_signature',
        denyMessage: 'QR code could not be verified',
      };
    }
    const entitlement = await entitlements.findById(decoded.entitlementId);
    const decision = evaluateAdmission(entitlement, event.id);
    if (!decision.admitted) {
      return {
        status: 'invalid',
        denyReason: decision.denyReason,
        denyMessage: decision.denyMessage,
        ...(entitlement && decision.denyReason !== 'wrong_event'
          ? { entitlement: ticketSummary(entitlement) }
          : {}),
      };
    }
    return {
      status: 'valid',
      denyReason: null,
      denyMessage: null,
      ...(entitlement ? { entitlement: ticketSummary(entitlement) } : {}),
    };
  }

  async function getScan(checkInId: EntityId, actor: ActorContext): Promise<ScanLedger> {
    const scanRecord = await scanLedger.findById(checkInId);
    if (!scanRecord) throw new NotFoundError('Scan', checkInId);
    requireOrgAccess(actor, scanRecord.organizationId);
    return scanRecord;
  }

  /**
   * Manually admits a guest whose scan was denied.
   *
   * Deliberately does NOT touch the entitlement's `scanCount`: an override is
   * a human decision recorded against one refusal, not a repaired ticket. If
   * it topped the ticket back up, one override would silently grant unlimited
   * further entries.
   */
  async function overrideScan(
    checkInId: EntityId,
    reason: string,
    actor: ActorContext,
  ): Promise<ScanLedger> {
    const before = await getScan(checkInId, actor);
    const updated = await scanLedger.markOverridden(checkInId, actor.userId, reason);
    if (!updated) throw new NotFoundError('Scan', checkInId);
    await adminAudit.write({
      id: `audit-override-${checkInId}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action: 'door.scan_override',
      targetType: 'scan_ledger',
      targetId: checkInId,
      before: { status: before.status, denyReason: before.denyReason },
      after: { status: updated.status, overriddenBy: updated.overriddenBy, reason },
    });
    return updated;
  }

  /**
   * The rotating "magic ticket" payload.
   *
   * Readable by the ticket holder OR by staff of the organization running the
   * event — both are real callers (a guest opening their wallet, and door
   * staff re-presenting a QR for a guest whose phone died). Anyone else is a
   * 404, not a 403, so a stranger cannot confirm a ticket id exists.
   */
  async function generateMagicTicketQr(
    ticketId: EntityId,
    actor: ActorContext,
  ): Promise<{ qrPayload: string; expiresAt: string; refreshIntervalSec: number }> {
    const entitlement = await entitlements.findById(ticketId);
    if (!entitlement) throw new NotFoundError('Ticket', ticketId);
    const isHolder = entitlement.userId !== null && entitlement.userId === actor.userId;
    const isStaff = entitlement.organizationId === actor.organizationId;
    if (!isHolder && !isStaff) throw new NotFoundError('Ticket', ticketId);

    const windowStart = Math.floor(Date.now() / 1000 / MAGIC_WINDOW_SEC) * MAGIC_WINDOW_SEC;
    return {
      qrPayload: `${ticketId}:${windowStart}:${hmacHex(`${ticketId}:${windowStart}`)}`,
      expiresAt: new Date((windowStart + MAGIC_WINDOW_SEC) * 1000).toISOString(),
      refreshIntervalSec: MAGIC_WINDOW_SEC,
    };
  }

  // ── devices ───────────────────────────────────────────────────────────────

  /**
   * Authorizes a handset for this tenant's doors, or refreshes one already
   * authorized. Called explicitly by the app on launch, and implicitly by
   * `openSession` so a manager never has to pre-register a phone before a
   * shift can start — which is why it carries no `door.manage` requirement.
   *
   * **It will not resurrect an unbound device.** That openness is safe only
   * while binding grants nothing on its own (a device still needs a door code
   * and a session to scan). Reactivation is different: a manager unbinds a
   * stolen handset, and if this path reactivated it, any org member — or
   * whoever took the phone, still holding a staff login — could walk the
   * revocation straight back by re-registering the same device id. Turning
   * authority back on is a `door.manage` act, and goes through
   * `reauthorizeDevice`.
   */
  async function bindDevice(
    command: BindDeviceCommand,
    actor: ActorContext,
  ): Promise<ScannerDevice> {
    const existing = await scannerDevices.findByDevice(actor.organizationId, command.deviceId);
    if (existing && existing.status !== 'active') {
      throw new DeviceNotAuthorizedError(
        'This device was unbound — a manager must re-authorize it',
      );
    }
    const device = existing
      ? rebindScannerDevice(existing, {
          deviceName: command.deviceName,
          venueId: command.venueId ?? existing.venueId,
          boundBy: actor.userId,
        })
      : bindScannerDevice({
          organizationId: actor.organizationId,
          venueId: command.venueId ?? null,
          deviceId: command.deviceId,
          deviceName: command.deviceName,
          boundBy: actor.userId,
        });
    await scannerDevices.save(device);
    if (!existing) {
      await adminAudit.write({
        id: `audit-device-${device.id}-${Date.now()}`,
        adminId: actor.userId,
        actorId: actor.userId,
        organizationId: actor.organizationId,
        action: 'scanner_device.bind',
        targetType: 'scanner_device',
        targetId: device.id,
        after: { deviceId: device.deviceId, deviceName: device.deviceName },
      });
    }
    return device;
  }

  /**
   * "This scanner is still on the door." Authenticated by the session token
   * rather than by a device id in the body — otherwise any caller could keep
   * a decommissioned device looking alive on the dashboard.
   */
  async function heartbeat(command: HeartbeatCommand, actor: ActorContext): Promise<ScannerDevice> {
    const session = await authenticateSession(command.sessionToken, command.eventId);
    requireOrgAccess(actor, session.organizationId);
    const device = await requireBoundDevice(session);
    await scannerSessions.updateLastUsed(session.id);
    await scannerDevices.touch(device.id, {
      lastSeenAt: new Date().toISOString(),
      lastEventId: command.eventId,
      lastGate: command.gate ?? device.lastGate,
    });
    const refreshed = await scannerDevices.findById(device.id);
    return refreshed ?? device;
  }

  /**
   * Turns a previously unbound handset back on. Separate from `bindDevice`
   * and gated on `door.manage` at the route, because re-granting authority is
   * a manager decision — see `bindDevice`'s comment for the attack this
   * closes. The audit record names who did it.
   */
  async function reauthorizeDevice(
    deviceId: string,
    deviceName: string,
    actor: ActorContext,
  ): Promise<ScannerDevice> {
    const existing = await scannerDevices.findByDevice(actor.organizationId, deviceId);
    if (!existing) throw new NotFoundError('Scanner device', deviceId);
    requireOrgAccess(actor, existing.organizationId);

    const device = rebindScannerDevice(existing, {
      deviceName,
      venueId: existing.venueId,
      boundBy: actor.userId,
    });
    await scannerDevices.save(device);
    await adminAudit.write({
      id: `audit-device-${device.id}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action: 'scanner_device.reauthorize',
      targetType: 'scanner_device',
      targetId: device.id,
      before: { status: existing.status, unboundReason: existing.unboundReason },
      after: { status: device.status },
    });
    return device;
  }

  async function listDevices(
    query: PaginationQuery,
    actor: ActorContext,
  ): Promise<Page<ScannerDevice>> {
    return scannerDevices.listByOrganization(actor.organizationId, query);
  }

  /**
   * The "this phone was stolen" button. Takes effect on the next scan even
   * though the device's session token is still cryptographically valid, and
   * closes its live sessions so it cannot finish the shift either.
   */
  async function unbindDevice(
    deviceId: string,
    reason: string,
    actor: ActorContext,
  ): Promise<ScannerDevice> {
    const existing = await scannerDevices.findByDevice(actor.organizationId, deviceId);
    if (!existing) throw new NotFoundError('Scanner device', deviceId);
    requireOrgAccess(actor, existing.organizationId);
    const unbound = unbindScannerDevice(existing, reason);
    await scannerDevices.save(unbound);

    const sessions = await scannerSessions.findByDevice(deviceId, { cursor: null, limit: 100 });
    for (const session of sessions.items) {
      if (session.organizationId !== actor.organizationId) continue;
      if (!isSessionValid(session)) continue;
      await scannerSessions.revoke(session.id, `device unbound: ${reason}`);
      await eventCodes.adjustActiveSessions(session.codeId, -1);
    }

    await adminAudit.write({
      id: `audit-device-${existing.id}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action: 'scanner_device.unbind',
      targetType: 'scanner_device',
      targetId: existing.id,
      before: { status: existing.status },
      after: { status: unbound.status, reason, sessionsRevoked: sessions.items.length },
    });
    return unbound;
  }

  // ── couple confirmation ───────────────────────────────────────────────────

  /**
   * Second half of a couple admission. Both seats are consumed in ONE claim,
   * or neither is.
   *
   * Everything re-checked here comes out of the signed token, not out of the
   * request: the caller cannot point a valid confirmation at a different
   * ticket, a different door, or a ticket whose state has moved since staff
   * were asked the question.
   */
  async function confirmCouple(
    command: ConfirmCoupleCommand,
    actor: ActorContext,
  ): Promise<ScanResult> {
    const event = await requireEvent(command.eventId, actor);
    const session = await authenticateSession(command.sessionToken, command.eventId);
    requireOrgAccess(actor, session.organizationId);
    if (!canSessionScan(session)) {
      throw new ForbiddenError('This scanner session may not scan tickets');
    }
    await requireBoundDevice(session);

    const claims = verifyConfirmationToken(command.confirmationToken);
    if (
      !claims ||
      claims.eventId !== event.id ||
      claims.sessionId !== session.id ||
      claims.deviceId !== session.deviceId
    ) {
      // Expired, forged, or aimed at another door — one answer for all three.
      throw new UnauthorizedError('Confirmation is no longer valid — scan the ticket again');
    }

    const base = {
      eventId: event.id,
      organizationId: event.organizationId,
      venueId: event.venueId,
      session,
      actor,
      input: { ...command, gate: command.gate ?? null },
      entitlementId: claims.entitlementId,
    };

    if (!command.confirmed) {
      // Staff looked and only one guest is there. Recorded as a real denial,
      // because "we turned a couple away at 1am" is exactly the kind of thing
      // a venue gets asked about later.
      const current = await entitlements.findById(claims.entitlementId);
      const denied = await recordScan({
        ...base,
        entitlement: current,
        admitted: false,
        denyReason: 'override_required',
        denyMessage: 'Both guests were not present',
        scansUsed: current?.scanCount ?? null,
        scansAllowed: current?.scanCountAllowed ?? null,
      });
      await bumpCodeUsage(session.codeId);
      return {
        scan: denied,
        status: 'denied',
        denyReason: 'override_required',
        denyMessage: 'Both guests were not present',
      };
    }

    const claim = await entitlements.claimAdmission(claims.entitlementId, event.id, {
      seats: claims.seats,
      expectedScansUsed: claims.expectedScansUsed,
    });
    const scanRecord = await recordScan({
      ...base,
      entitlement: claim.entitlement,
      admitted: claim.admitted,
      denyReason: claim.denyReason,
      denyMessage: claim.denyMessage,
      scansUsed: claim.scansUsed,
      scansAllowed: claim.scansAllowed,
      // Both guests walk through on one record — the door counted two people.
      admittedCount: claim.admitted ? claims.seats : 0,
    });
    await bumpCodeUsage(session.codeId);
    await touchDevice(session, {
      lastSeenAt: new Date().toISOString(),
      lastEventId: event.id,
      lastScanAt: scanRecord.scannedAt,
      lastScanResult: claim.admitted ? 'consumed' : (claim.denyReason ?? 'denied'),
      incrementScanCount: true,
    });

    if (!claim.admitted) {
      return {
        scan: scanRecord,
        status: 'denied',
        ...(claim.denyReason ? { denyReason: claim.denyReason } : {}),
        ...(claim.denyMessage ? { denyMessage: claim.denyMessage } : {}),
      };
    }
    return {
      scan: scanRecord,
      status: 'consumed',
      ...(claim.entitlement ? { entitlement: ticketSummary(claim.entitlement) } : {}),
    };
  }

  // ── audit ─────────────────────────────────────────────────────────────────

  /**
   * Staff physically refused someone whose ticket scanned fine — too drunk,
   * wrong dress code, barred. The ticket is deliberately NOT consumed: the
   * guest was not admitted, and burning their entry would turn a door
   * judgement into a refund dispute. Only the refusal is recorded.
   */
  async function recordStaffDeny(
    command: StaffDenyCommand,
    actor: ActorContext,
  ): Promise<ScanLedger> {
    const event = await requireEvent(command.eventId, actor);
    const session = await authenticateSession(command.sessionToken, command.eventId);
    requireOrgAccess(actor, session.organizationId);
    await requireBoundDevice(session);

    const decoded = command.qrPayload ? decodeQr(command.qrPayload) : { entitlementId: null };
    const entitlement = decoded.entitlementId
      ? await entitlements.findById(decoded.entitlementId)
      : null;
    const record = await recordScan({
      eventId: event.id,
      organizationId: event.organizationId,
      venueId: event.venueId,
      session,
      actor,
      input: { gate: command.gate ?? null },
      entitlementId: decoded.entitlementId,
      entitlement: entitlement?.eventId === event.id ? entitlement : null,
      admitted: false,
      denyReason: 'override_required',
      denyMessage: `Refused by staff: ${command.reason}`,
      scansUsed: null,
      scansAllowed: null,
    });
    await adminAudit.write({
      id: `audit-staffdeny-${record.id}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: event.organizationId,
      action: 'door.staff_deny',
      targetType: 'scan_ledger',
      targetId: record.id,
      after: { reason: command.reason, entitlementId: decoded.entitlementId },
    });
    return record;
  }

  // ── offline ───────────────────────────────────────────────────────────────

  /**
   * Pre-authorization for a device that will lose connectivity.
   *
   * Each entry is signed with the same key the sync path verifies, so the
   * device cannot add a ticket to its own manifest, and the server can tell a
   * genuinely pre-authorized offline admission from a fabricated one. The
   * manifest is NOT an admission: syncing still runs the same atomic claim,
   * so two offline devices that both admitted the same couple ticket produce
   * one admission and one recorded conflict rather than two admissions.
   */
  async function buildOfflineManifest(
    eventId: EntityId,
    sessionToken: string,
    actor: ActorContext,
  ): Promise<OfflineManifest> {
    const event = await requireEvent(eventId, actor);
    const session = await authenticateSession(sessionToken, eventId);
    requireOrgAccess(actor, session.organizationId);
    if (!canSessionScan(session)) {
      throw new ForbiddenError('This scanner session may not scan tickets');
    }

    const signedAt = new Date();
    const expiresAt = new Date(signedAt.getTime() + OFFLINE_MANIFEST_TTL_MS);
    const entries: OfflineManifestEntry[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<Entitlement> = await entitlements.listByEvent(event.id, {
        cursor,
        limit: 500,
      });
      for (const entitlement of page.items) {
        if (entitlement.status === 'void') continue;
        if (entitlement.scanCount >= entitlement.scanCountAllowed) continue;
        entries.push({
          entitlementId: entitlement.id,
          validFrom: signedAt.toISOString(),
          validTo: expiresAt.toISOString(),
          signature: hmacHex(
            `manifest:${event.id}:${entitlement.id}:${signedAt.toISOString()}:${expiresAt.toISOString()}`,
          ),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);

    return {
      manifest: entries,
      signedAt: signedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Replays scans a device took while offline.
   *
   * Every entry runs the full online decision — this is not a bulk insert.
   * An offline device can be wrong (the ticket was refunded, or another door
   * admitted the same guest first), and the server, which has the complete
   * picture, is the one that decides. Entries the server refuses come back as
   * `conflicts` so the operator learns who actually got in on a bad ticket.
   */
  async function syncOfflineScans(
    input: OfflineSyncInput,
    actor: ActorContext,
  ): Promise<OfflineSyncResult> {
    const event = await requireEvent(input.eventId, actor);
    const session = await authenticateSession(input.sessionToken, input.eventId);
    requireOrgAccess(actor, session.organizationId);
    if (!canSessionScan(session)) {
      throw new ForbiddenError('This scanner session may not scan tickets');
    }

    const conflicts: { payload: string; reason: string }[] = [];
    let synced = 0;

    for (const offline of input.scans) {
      const decoded = decodeQr(offline.payload);
      if (!decoded.entitlementId) {
        conflicts.push({ payload: offline.payload, reason: 'invalid_signature' });
        await recordScan({
          eventId: event.id,
          organizationId: event.organizationId,
          venueId: event.venueId,
          session,
          actor,
          input: { scannedAt: offline.scannedAt },
          entitlementId: null,
          entitlement: null,
          admitted: false,
          denyReason: 'invalid_signature',
          denyMessage: 'Offline QR code could not be verified',
          scansUsed: null,
          scansAllowed: null,
          isOffline: true,
          offlineDeviceId: offline.deviceId,
        });
        continue;
      }

      const claim = await entitlements.claimAdmission(decoded.entitlementId, event.id);
      await recordScan({
        eventId: event.id,
        organizationId: event.organizationId,
        venueId: event.venueId,
        session,
        actor,
        input: { scannedAt: offline.scannedAt },
        entitlementId: decoded.entitlementId,
        entitlement: claim.denyReason === 'wrong_event' ? null : claim.entitlement,
        admitted: claim.admitted,
        denyReason: claim.denyReason,
        denyMessage: claim.denyMessage,
        scansUsed: claim.scansUsed,
        scansAllowed: claim.scansAllowed,
        isOffline: true,
        offlineDeviceId: offline.deviceId,
      });

      if (claim.admitted) synced += 1;
      else conflicts.push({ payload: offline.payload, reason: claim.denyReason ?? 'denied' });
    }

    await bumpCodeUsage(session.codeId);
    return { synced, conflicts };
  }

  return {
    createEventCode,
    listEventCodes,
    revokeEventCode,
    listSessionsForCode,
    openSession,
    authenticateSession,
    getSession,
    revokeSession,
    scan,
    resolve,
    bindDevice,
    reauthorizeDevice,
    heartbeat,
    listDevices,
    unbindDevice,
    confirmCouple,
    recordStaffDeny,
    getScan,
    overrideScan,
    generateMagicTicketQr,
    buildOfflineManifest,
    syncOfflineScans,
  };
}

export function createScannerService(deps: ScannerServiceDeps): ScannerService {
  return createScannerServiceImpl(deps);
}
