import { InvalidOperationError, ForbiddenError, NotFoundError } from '../../domain/errors.js';
import { isSessionValid, canSessionScan } from '../../domain/models/event-code.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  EventCode,
  EventCodeCreateInput,
  ScannerSession,
  ScannerSessionCreateInput,
} from '../../domain/models/event-code.js';
import type {
  ScanLedger,
  ScanLedgerCreateInput,
  ScanDenyReason,
} from '../../domain/models/scan-ledger.js';
import type { ServiceDeps, ActorContext } from '../context.js';

/**
 * ─── Scanner Service (Phase 5) ──────────────────────────────────────────────────
 *
 * Core logic for ticket scanning, event code management, and scanner sessions.
 * All state transitions validated. No process.env. No Firebase Admin in this layer.
 */

export interface ScannerServiceDeps {
  scanLedger: ServiceDeps['repositories']['scanLedger'];
  eventCodes: ServiceDeps['repositories']['eventCodes'];
  scannerSessions: ServiceDeps['repositories']['scannerSessions'];
  entitlements: ServiceDeps['repositories']['entitlements'];
  repositories: ServiceDeps['repositories'];
  config: ServiceDeps['config'];
  logger: ServiceDeps['logger'];
  outbox: ServiceDeps['outbox'];
  adminAudit: ServiceDeps['adminAudit'];
}

export interface ScannerService {
  // Event Code management
  createEventCode(input: EventCodeCreateInput, actor: ActorContext): Promise<EventCode>;
  validateEventCode(code: string, actor: ActorContext): Promise<EventCode>;
  revokeEventCode(codeId: EntityId, reason: string, actor: ActorContext): Promise<EventCode>;
  listEventCodes(eventId: EntityId, actor: ActorContext): Promise<EventCode[]>;

  // Scanner Session management
  createScannerSession(
    input: ScannerSessionCreateInput,
    actor: ActorContext,
  ): Promise<{
    session: ScannerSession;
    sessionToken: string;
    sessionExpiresAt: string;
    sessionId: string;
  }>;
  validateSession(token: string): Promise<ScannerSession | null>;
  revokeSession(sessionId: EntityId, reason: string, actor: ActorContext): Promise<ScannerSession>;

  // Ticket Scanning
  scanTicket(input: ScanTicketInput, actor: ActorContext): Promise<ScanResult>;
  scanMagicTicket(input: ScanMagicTicketInput, actor: ActorContext): Promise<ScanResult>;

  // Read-only lookups (no ledger write) — GET /door/sessions/:id,
  // GET /door/check-ins/:id, POST /door/check-ins/verify, POST /door/lookup,
  // GET /tickets/:id/qr
  getSession(sessionId: EntityId, actor: ActorContext): Promise<ScannerSession>;
  getScan(checkInId: EntityId, actor: ActorContext): Promise<ScanLedger>;
  /** `POST /door/override` — manually admits a denied entry. Requires `ticket.override`. */
  overrideScan(checkInId: EntityId, reason: string, actor: ActorContext): Promise<ScanLedger>;
  resolveTicket(input: ResolveTicketInput, actor: ActorContext): Promise<TicketResolution>;
  resolveMagicTicket(
    input: ResolveMagicTicketInput,
    actor: ActorContext,
  ): Promise<TicketResolution>;
  generateMagicTicketQr(
    ticketId: EntityId,
    actor: ActorContext,
  ): Promise<{ qrPayload: string; expiresAt: string; refreshIntervalSec: number }>;

  // Offline sync
  syncOfflineScans(scans: ScanLedgerCreateInput[], actor: ActorContext): Promise<ScanLedger[]>;
}

export interface ResolveTicketInput {
  eventId: EntityId;
  entitlementId: EntityId;
  deviceId: string;
}

export interface ResolveMagicTicketInput {
  eventId: EntityId;
  qrPayload: string;
  deviceId: string;
}

/**
 * The verdict of a non-consuming ticket lookup. `status: 'valid'` means the
 * ticket WOULD be admitted right now; `'invalid'` carries the reason. Nothing
 * is persisted — the absence of a `checkInId` on the wire is what
 * distinguishes a preview response from a real scan.
 */
export interface TicketResolution {
  status: 'valid' | 'invalid';
  denyReason: ScanDenyReason | null;
  denyMessage: string | null;
  entitlement?: {
    id: EntityId;
    tierName: string;
    holderName: string;
    scansUsed: number;
    scansAllowed: number;
  };
}

export interface ScanTicketInput {
  eventId: EntityId;
  entitlementId: EntityId;
  gate: string;
  deviceId: string;
  operatorUid: EntityId;
  operatorName: string;
  operatorRole: string;
  scannedAt: string;
  offlineDeviceId?: string;
  isOffline?: boolean;
}

export interface ScanMagicTicketInput {
  eventId: EntityId;
  qrPayload: string; // HMAC(entitlementId:timestamp)
  gate: string;
  deviceId: string;
  operatorUid: EntityId;
  operatorName: string;
  operatorRole: string;
  scannedAt: string;
}

export interface ScanResult {
  scan: ScanLedger;
  status: 'consumed' | 'denied';
  denyReason?: ScanDenyReason;
  denyMessage?: string;
  entitlement?: {
    id: EntityId;
    tierName: string;
    tierId: EntityId;
    holderName: string;
    scansUsed: number;
    scansAllowed: number;
    status: string;
  };
}

function createScannerServiceImpl(deps: ScannerServiceDeps): ScannerService {
  const { scanLedger, eventCodes, scannerSessions, entitlements, config, adminAudit } = deps;

  async function createEventCode(
    input: EventCodeCreateInput,
    actor: ActorContext,
  ): Promise<EventCode> {
    requireOrgAccess(actor, input.organizationId);
    const created = await eventCodes.create(input);
    await adminAudit.write({
      id: `audit-${created.id}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action: 'event_code.create',
      targetType: 'event_code',
      targetId: created.id,
      after: { ...created },
    });
    return created;
  }

  async function validateEventCode(codeStr: string, actor: ActorContext): Promise<EventCode> {
    const code = await eventCodes.findByCode(codeStr);
    if (!code) {
      throw new NotFoundError('Event code', codeStr);
    }
    if (code.organizationId !== actor.organizationId) {
      throw new ForbiddenError('Cross-tenant access denied');
    }
    if (code.status !== 'active') {
      throw new InvalidOperationError(`Event code is ${code.status}`);
    }
    if (code.expiresAt && new Date(code.expiresAt) < new Date()) {
      await eventCodes.updateStatus(code.id, 'expired');
      throw new InvalidOperationError('Event code has expired');
    }
    return code;
  }

  async function revokeEventCode(
    codeId: EntityId,
    reason: string,
    actor: ActorContext,
  ): Promise<EventCode> {
    const code = await eventCodes.findById(codeId);
    if (!code) throw new NotFoundError('Event code', codeId);
    requireOrgAccess(actor, code.organizationId);

    const updated = await eventCodes.updateStatus(codeId, 'revoked', reason);
    if (!updated) throw new NotFoundError('Event code', codeId);

    await adminAudit.write({
      id: `audit-${codeId}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action: 'event_code.revoke',
      targetType: 'event_code',
      targetId: codeId,
      before: { ...code },
      after: { ...updated },
    });
    return updated;
  }

  async function listEventCodes(eventId: EntityId, actor: ActorContext): Promise<EventCode[]> {
    const event = await deps.repositories.events.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    requireOrgAccess(actor, event.organizationId);

    return eventCodes.findActiveByEvent(eventId);
  }

  async function createScannerSession(
    input: ScannerSessionCreateInput,
    actor: ActorContext,
  ): Promise<{
    session: ScannerSession;
    sessionToken: string;
    sessionExpiresAt: string;
    sessionId: string;
  }> {
    const code = await eventCodes.findById(input.codeId);
    if (!code) throw new NotFoundError('Event code', input.codeId);
    requireOrgAccess(actor, code.organizationId);

    if (code.status !== 'active') {
      throw new InvalidOperationError('Cannot create session for inactive code');
    }

    // Check max devices
    if (code.stats.activeSessions >= code.maxDevices && !code.allowReuse) {
      throw new InvalidOperationError('Max devices reached for this code');
    }

    const result = await scannerSessions.create(input);

    await eventCodes.adjustActiveSessions(code.id, 1);
    await adminAudit.write({
      id: `audit-${result.sessionId}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action: 'scanner_session.create',
      targetType: 'scanner_session',
      targetId: result.sessionId,
      after: { ...result.session },
    });

    return result;
  }

  async function validateSession(token: string): Promise<ScannerSession | null> {
    // Hash the token to find session
    const crypto = await import('crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = await scannerSessions.findByTokenHash(tokenHash);

    if (!session) return null;
    if (!isSessionValid(session)) return null;

    return session;
  }

  /**
   * Scan-time session lookup. `ScanRequest`'s wire contract only ever gives
   * the scanner a `deviceId` (`sessionToken` is deliberately never re-servable
   * after session creation — see `ScannerSession.sessionToken`'s doc comment),
   * so there is no bearer token here to hash and look up via
   * `findByTokenHash` the way `validateSession` above does. This resolves the
   * device's most recent still-valid session for the event instead. A real
   * device-bearer-token auth layer (client presents the raw `sessionToken` on
   * every scan) is still open follow-up per `PHASE_5_HTTP_WIRING_PLAN.md`;
   * this device-lookup is the interim scheme it will replace.
   */
  async function validateSessionByDevice(
    eventId: EntityId,
    deviceId: string,
  ): Promise<ScannerSession | null> {
    const page = await scannerSessions.findByDevice(deviceId, { cursor: null, limit: 50 });
    const valid = page.items.filter((s) => s.eventId === eventId && isSessionValid(s));
    if (valid.length === 0) return null;
    return valid.reduce((latest, s) => (s.createdAt > latest.createdAt ? s : latest));
  }

  async function revokeSession(
    sessionId: EntityId,
    reason: string,
    actor: ActorContext,
  ): Promise<ScannerSession> {
    const session = await scannerSessions.findById(sessionId);
    if (!session) throw new NotFoundError('Scanner session', sessionId);

    const code = await eventCodes.findById(session.codeId);
    if (!code) throw new NotFoundError('Event code', session.codeId);
    requireOrgAccess(actor, code.organizationId);

    const updated = await scannerSessions.revoke(sessionId, reason);
    if (!updated) throw new NotFoundError('Scanner session', sessionId);

    await eventCodes.adjustActiveSessions(code.id, -1);
    await adminAudit.write({
      id: `audit-${sessionId}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action: 'scanner_session.revoke',
      targetType: 'scanner_session',
      targetId: sessionId,
      before: { ...session },
      after: { ...updated },
    });

    return updated;
  }

  async function scanTicket(input: ScanTicketInput, actor: ActorContext): Promise<ScanResult> {
    const event = await deps.repositories.events.findById(input.eventId);
    if (!event) throw new NotFoundError('Event', input.eventId);
    requireOrgAccess(actor, event.organizationId);

    // Verify session has scan permission
    const session = await validateSessionByDevice(input.eventId, input.deviceId);
    if (!session || !canSessionScan(session)) {
      throw new ForbiddenError('Session cannot scan tickets');
    }

    // Check for duplicate scan
    const existing = await scanLedger.findByEventAndEntitlement(input.eventId, input.entitlementId);
    if (existing && existing.status === 'consumed') {
      const denyInput: ScanLedgerCreateInput = {
        ...input,
        organizationId: actor.organizationId,
        venueId: event.venueId,
        doorSaleId: null,
        entryType: null,
        tierName: null,
        tierId: null,
        deviceName: session.deviceName,
        deviceBound: true,
        isOffline: input.isOffline ?? false,
        offlineDeviceId: input.offlineDeviceId ?? null,
        status: 'denied',
        denyReason: 'already_used',
        denyMessage: 'Ticket already scanned',
        guestName: null,
        guestEmail: null,
        guestPhone: null,
        admittedCount: 0,
        scanCountUsed: existing.scanCountUsed,
        scanCountAllowed: existing.scanCountAllowed,
      };
      const denyResult = await scanLedger.create(denyInput);
      return {
        scan: denyResult,
        status: 'denied',
        denyReason: 'already_used',
        denyMessage: 'Ticket already scanned',
      };
    }

    // Get entitlement
    const entitlement = await entitlements.findById(input.entitlementId);
    if (!entitlement) {
      const denyInput: ScanLedgerCreateInput = {
        ...input,
        organizationId: actor.organizationId,
        venueId: event.venueId,
        doorSaleId: null,
        entryType: null,
        tierName: null,
        tierId: null,
        deviceName: session.deviceName,
        deviceBound: true,
        isOffline: input.isOffline ?? false,
        offlineDeviceId: input.offlineDeviceId ?? null,
        status: 'denied',
        denyReason: 'invalid_signature',
        denyMessage: 'Entitlement not found',
        guestName: null,
        guestEmail: null,
        guestPhone: null,
        admittedCount: 0,
        scanCountUsed: null,
        scanCountAllowed: null,
      };
      const denyResult = await scanLedger.create(denyInput);
      return {
        scan: denyResult,
        status: 'denied',
        denyReason: 'invalid_signature',
        denyMessage: 'Entitlement not found',
      };
    }

    // Verify entitlement belongs to event
    if (entitlement.eventId !== input.eventId) {
      const denyInput: ScanLedgerCreateInput = {
        ...input,
        organizationId: actor.organizationId,
        venueId: event.venueId,
        doorSaleId: null,
        entryType: null,
        tierName: entitlement.tierName,
        tierId: entitlement.tierId,
        deviceName: session.deviceName,
        deviceBound: true,
        isOffline: input.isOffline ?? false,
        offlineDeviceId: input.offlineDeviceId ?? null,
        status: 'denied',
        denyReason: 'wrong_event',
        denyMessage: 'Ticket for different event',
        guestName: null,
        guestEmail: null,
        guestPhone: null,
        admittedCount: 0,
        scanCountUsed: null,
        scanCountAllowed: null,
      };
      const denyResult = await scanLedger.create(denyInput);
      return {
        scan: denyResult,
        status: 'denied',
        denyReason: 'wrong_event',
        denyMessage: 'Ticket for different event',
      };
    }

    // Check entitlement status
    if (entitlement.status === 'void') {
      const denyInput: ScanLedgerCreateInput = {
        ...input,
        organizationId: actor.organizationId,
        venueId: event.venueId,
        doorSaleId: null,
        entryType: null,
        tierName: entitlement.tierName,
        tierId: entitlement.tierId,
        deviceName: session.deviceName,
        deviceBound: true,
        isOffline: input.isOffline ?? false,
        offlineDeviceId: input.offlineDeviceId ?? null,
        status: 'denied',
        denyReason: 'void_ticket',
        denyMessage: 'Ticket is void',
        guestName: entitlement.holderName,
        guestEmail: null,
        guestPhone: null,
        admittedCount: 0,
        scanCountUsed: entitlement.scanCount,
        scanCountAllowed: entitlement.scanCountAllowed,
      };
      const denyResult = await scanLedger.create(denyInput);
      return {
        scan: denyResult,
        status: 'denied',
        denyReason: 'void_ticket',
        denyMessage: 'Ticket is void',
      };
    }

    // Check if entitlement is expired (using scannedAt as proxy)
    const lastScanTime =
      entitlement.scannedAt && entitlement.scannedAt.length > 0
        ? entitlement.scannedAt[entitlement.scannedAt.length - 1]
        : null;
    if (lastScanTime && new Date(lastScanTime) < new Date()) {
      const denyInput: ScanLedgerCreateInput = {
        ...input,
        organizationId: actor.organizationId,
        venueId: event.venueId,
        doorSaleId: null,
        entryType: null,
        tierName: entitlement.tierName,
        tierId: entitlement.tierId,
        deviceName: session.deviceName,
        deviceBound: true,
        isOffline: input.isOffline ?? false,
        offlineDeviceId: input.offlineDeviceId ?? null,
        status: 'denied',
        denyReason: 'expired',
        denyMessage: 'Ticket has expired',
        guestName: entitlement.holderName,
        guestEmail: null,
        guestPhone: null,
        admittedCount: 0,
        scanCountUsed: entitlement.scanCount,
        scanCountAllowed: entitlement.scanCountAllowed,
      };
      const denyResult = await scanLedger.create(denyInput);
      return {
        scan: denyResult,
        status: 'denied',
        denyReason: 'expired',
        denyMessage: 'Ticket has expired',
      };
    }

    // Check scans used
    const scansUsed = entitlement.scanCount ?? 0;
    const scansAllowed = entitlement.scanCountAllowed ?? 1;
    if (scansUsed >= scansAllowed) {
      const denyInput: ScanLedgerCreateInput = {
        ...input,
        organizationId: actor.organizationId,
        venueId: event.venueId,
        doorSaleId: null,
        entryType: null,
        tierName: entitlement.tierName,
        tierId: entitlement.tierId,
        deviceName: session.deviceName,
        deviceBound: true,
        isOffline: input.isOffline ?? false,
        offlineDeviceId: input.offlineDeviceId ?? null,
        status: 'denied',
        denyReason: 'already_used',
        denyMessage: 'All scans for this ticket have been used',
        guestName: entitlement.holderName,
        guestEmail: null,
        guestPhone: null,
        admittedCount: 0,
        scanCountUsed: scansUsed,
        scanCountAllowed: scansAllowed,
      };
      const denyResult = await scanLedger.create(denyInput);
      return {
        scan: denyResult,
        status: 'denied',
        denyReason: 'already_used',
        denyMessage: 'All scans for this ticket have been used',
      };
    }

    // Create scan ledger entry
    const scanInput: ScanLedgerCreateInput = {
      eventId: input.eventId,
      organizationId: actor.organizationId,
      venueId: event.venueId,
      entitlementId: input.entitlementId,
      doorSaleId: null,
      entryType: 'general',
      tierName: entitlement.tierName,
      tierId: entitlement.tierId,
      operatorUid: input.operatorUid,
      operatorName: input.operatorName,
      operatorRole: input.operatorRole,
      gate: input.gate,
      deviceId: input.deviceId,
      deviceName: session.deviceName,
      deviceBound: true,
      guestName: entitlement.holderName,
      guestEmail: null,
      guestPhone: null,
      scannedAt: input.scannedAt,
      admittedCount: 1,
      scanCountUsed: scansUsed + 1,
      scanCountAllowed: scansAllowed,
      isOffline: input.isOffline ?? false,
      offlineDeviceId: input.offlineDeviceId ?? null,
    };

    const created = await scanLedger.create({ ...scanInput, status: 'consumed' });

    await adminAudit.write({
      id: `audit-${created.id}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action: 'scan.consume',
      targetType: 'scan_ledger',
      targetId: created.id,
      after: { ...created },
    });

    return {
      scan: created,
      status: 'consumed',
      entitlement: {
        id: entitlement.id,
        tierName: entitlement.tierName,
        tierId: entitlement.tierId,
        holderName: entitlement.holderName,
        scansUsed: scansUsed + 1,
        scansAllowed: scansAllowed,
        status: entitlement.status,
      },
    };
  }

  async function scanMagicTicket(
    input: ScanMagicTicketInput,
    actor: ActorContext,
  ): Promise<ScanResult> {
    // Verify HMAC and extract entitlementId
    // This is a simplified version - in production, verify the rotating HMAC
    const event = await deps.repositories.events.findById(input.eventId);
    if (!event) throw new NotFoundError('Event', input.eventId);
    requireOrgAccess(actor, event.organizationId);

    // Parse QR payload: entitlementId:timestamp:hmac
    const parts = input.qrPayload.split(':');
    if (parts.length < 3) {
      throw new InvalidOperationError('Invalid QR payload format');
    }

    const entitlementId = parts[0] ?? '';
    const timestampStr = parts[1];
    const hmac = parts[2];
    if (!timestampStr) {
      throw new InvalidOperationError('Invalid timestamp in QR payload');
    }
    const timestamp = parseInt(timestampStr, 10);

    // Verify HMAC (simplified - use proper crypto in production)
    const crypto = await import('crypto');
    const secret = config.magicTicketSecret ?? 'default-magic-ticket-secret-change-in-production';
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${entitlementId}:${timestamp}`)
      .digest('hex');

    if (hmac !== expected) {
      // Check previous window (±65s clock drift)
      const prevWindow = timestamp - 30;
      const prevExpected = crypto
        .createHmac('sha256', secret)
        .update(`${entitlementId}:${prevWindow}`)
        .digest('hex');

      if (hmac !== prevExpected) {
        throw new InvalidOperationError('Invalid QR signature');
      }
    }

    // Now scan the ticket
    return scanTicket(
      {
        eventId: input.eventId,
        entitlementId,
        gate: input.gate,
        deviceId: input.deviceId,
        operatorUid: input.operatorUid,
        operatorName: input.operatorName,
        operatorRole: input.operatorRole,
        scannedAt: input.scannedAt,
      },
      actor,
    );
  }

  async function getSession(sessionId: EntityId, actor: ActorContext): Promise<ScannerSession> {
    const session = await scannerSessions.findById(sessionId);
    if (!session) throw new NotFoundError('Scanner session', sessionId);
    const code = await eventCodes.findById(session.codeId);
    if (!code) throw new NotFoundError('Event code', session.codeId);
    requireOrgAccess(actor, code.organizationId);
    return session;
  }

  async function getScan(checkInId: EntityId, actor: ActorContext): Promise<ScanLedger> {
    const scan = await scanLedger.findById(checkInId);
    if (!scan) throw new NotFoundError('Scan', checkInId);
    requireOrgAccess(actor, scan.organizationId);
    return scan;
  }

  /**
   * Manually admits a guest whose scan was denied. `getScan` does the
   * existence + org-access check (same guard every other read/write here
   * uses); the FSM guard against overriding a non-`denied` scan lives in the
   * domain (`overrideScan` in `scan-ledger.ts`), enforced by the repository
   * adapter. `ticket.override` itself is enforced at the route's
   * `requirePermission` preHandler, not re-checked here — this service
   * layer only re-verifies the org scope, matching every sibling method.
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

  function entitlementSummary(e: {
    id: EntityId;
    tierName: string;
    holderName: string;
    scanCount: number | null;
    scanCountAllowed: number | null;
  }): NonNullable<TicketResolution['entitlement']> {
    return {
      id: e.id,
      tierName: e.tierName,
      holderName: e.holderName,
      scansUsed: e.scanCount ?? 0,
      scansAllowed: e.scanCountAllowed ?? 1,
    };
  }

  async function resolveTicket(
    input: ResolveTicketInput,
    actor: ActorContext,
  ): Promise<TicketResolution> {
    const event = await deps.repositories.events.findById(input.eventId);
    if (!event) throw new NotFoundError('Event', input.eventId);
    requireOrgAccess(actor, event.organizationId);

    const entitlement = await entitlements.findById(input.entitlementId);
    if (!entitlement) {
      return {
        status: 'invalid',
        denyReason: 'invalid_signature',
        denyMessage: 'Entitlement not found',
      };
    }
    const summary = entitlementSummary(entitlement);
    if (entitlement.eventId !== input.eventId) {
      return {
        status: 'invalid',
        denyReason: 'wrong_event',
        denyMessage: 'Ticket for different event',
        entitlement: summary,
      };
    }
    if (entitlement.status === 'void') {
      return {
        status: 'invalid',
        denyReason: 'void_ticket',
        denyMessage: 'Ticket is void',
        entitlement: summary,
      };
    }
    const scansUsed = entitlement.scanCount ?? 0;
    const scansAllowed = entitlement.scanCountAllowed ?? 1;
    const existing = await scanLedger.findByEventAndEntitlement(input.eventId, input.entitlementId);
    if ((existing && existing.status === 'consumed') || scansUsed >= scansAllowed) {
      return {
        status: 'invalid',
        denyReason: 'already_used',
        denyMessage: 'All scans for this ticket have been used',
        entitlement: summary,
      };
    }
    return { status: 'valid', denyReason: null, denyMessage: null, entitlement: summary };
  }

  async function resolveMagicTicket(
    input: ResolveMagicTicketInput,
    actor: ActorContext,
  ): Promise<TicketResolution> {
    const event = await deps.repositories.events.findById(input.eventId);
    if (!event) throw new NotFoundError('Event', input.eventId);
    requireOrgAccess(actor, event.organizationId);

    const parts = input.qrPayload.split(':');
    const [entitlementId, timestampStr, hmac] = parts;
    if (parts.length < 3 || !entitlementId || !timestampStr || !hmac) {
      return {
        status: 'invalid',
        denyReason: 'invalid_signature',
        denyMessage: 'Invalid QR payload format',
      };
    }
    const timestamp = parseInt(timestampStr, 10);
    const crypto = await import('crypto');
    const secret = config.magicTicketSecret ?? 'default-magic-ticket-secret-change-in-production';
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${entitlementId}:${timestamp}`)
      .digest('hex');
    const prevExpected = crypto
      .createHmac('sha256', secret)
      .update(`${entitlementId}:${timestamp - 30}`)
      .digest('hex');
    if (hmac !== expected && hmac !== prevExpected) {
      return {
        status: 'invalid',
        denyReason: 'invalid_signature',
        denyMessage: 'Invalid QR signature',
      };
    }
    return resolveTicket(
      { eventId: input.eventId, entitlementId, deviceId: input.deviceId },
      actor,
    );
  }

  async function generateMagicTicketQr(
    ticketId: EntityId,
    actor: ActorContext,
  ): Promise<{ qrPayload: string; expiresAt: string; refreshIntervalSec: number }> {
    const entitlement = await entitlements.findById(ticketId);
    if (!entitlement) throw new NotFoundError('Ticket', ticketId);
    requireOrgAccess(actor, entitlement.organizationId);

    const crypto = await import('crypto');
    const secret = config.magicTicketSecret ?? 'default-magic-ticket-secret-change-in-production';
    const windowSec = 30;
    const timestamp = Math.floor(Date.now() / 1000 / windowSec) * windowSec;
    const hmac = crypto
      .createHmac('sha256', secret)
      .update(`${ticketId}:${timestamp}`)
      .digest('hex');
    return {
      qrPayload: `${ticketId}:${timestamp}:${hmac}`,
      expiresAt: new Date((timestamp + windowSec) * 1000).toISOString(),
      refreshIntervalSec: windowSec,
    };
  }

  async function syncOfflineScans(
    scans: ScanLedgerCreateInput[],
    _actor: ActorContext,
  ): Promise<ScanLedger[]> {
    const results: ScanLedger[] = [];
    for (const scanInput of scans) {
      const created = await scanLedger.create(scanInput);
      results.push(created);
    }
    return results;
  }

  return {
    createEventCode,
    validateEventCode,
    revokeEventCode,
    listEventCodes,
    createScannerSession,
    validateSession,
    revokeSession,
    scanTicket,
    scanMagicTicket,
    getSession,
    getScan,
    overrideScan,
    resolveTicket,
    resolveMagicTicket,
    generateMagicTicketQr,
    syncOfflineScans,
  };
}

function requireOrgAccess(actor: ActorContext, organizationId: EntityId): void {
  if (actor.organizationId !== organizationId) {
    throw new ForbiddenError('Cross-tenant access denied');
  }
}

export function createScannerService(deps: ScannerServiceDeps): ScannerService {
  return createScannerServiceImpl(deps);
}
