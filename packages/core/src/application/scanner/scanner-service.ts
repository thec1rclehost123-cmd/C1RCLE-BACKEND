import { InvalidOperationError, ForbiddenError, NotFoundError } from '../../domain/errors.js';
import { bumpVersion } from '../../domain/identity.js';
import type { ServiceDeps, ActorContext } from '../context.js';
import type { EntityId } from '../../domain/identity.js';
import type {
  ScanLedger,
  ScanLedgerStatus,
  ScanLedgerCreateInput,
  ScanDenyReason,
  canTransitionScan,
} from '../../domain/models/scan-ledger.js';
import {
  createScanLedger,
  transitionScanLedger,
} from '../../domain/models/scan-ledger.js';
import type {
  EventCode,
  EventCodeType,
  EventCodeStatus,
  EventCodeCreateInput,
  ScannerSession,
  ScannerSessionCreateInput,
  getSessionPermissions,
} from '../../domain/models/event-code.js';
import {
  createEventCode as createEventCodeModel,
  isSessionValid,
  canSessionScan,
  canSessionDoorEntry,
  canSessionWalkIn,
  canSessionCharge,
} from '../../domain/models/event-code.js';
import type {
  CoverWallet,
  CoverWalletTxn,
  CoverWalletCreateInput,
  CoverWalletCreditInput,
  CoverWalletDebitInput,
} from '../../domain/models/cover-wallet.js';
import {
  createCoverWallet,
  computeTerminationTime,
  isWalletActive,
  canWalletDebit,
  applyCredit,
  applyDebit,
} from '../../domain/models/cover-wallet.js';

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
  createScannerSession(input: ScannerSessionCreateInput, actor: ActorContext): Promise<{
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
  
  // Offline sync
  syncOfflineScans(scans: ScanLedgerCreateInput[], actor: ActorContext): Promise<ScanLedger[]>;
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
  const { scanLedger, eventCodes, scannerSessions, entitlements, config, logger, outbox, adminAudit } = deps;

  async function createEventCode(input: EventCodeCreateInput, actor: ActorContext): Promise<EventCode> {
    requireOrgAccess(actor, input.organizationId);
    const code = createEventCodeModel(input);
    const created = await eventCodes.create(code);
    await adminAudit.write({
      id: `audit-${created.id}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action: 'event_code.create',
      targetType: 'event_code',
      targetId: created.id,
      after: created as any,
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

  async function revokeEventCode(codeId: EntityId, reason: string, actor: ActorContext): Promise<EventCode> {
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
      before: code as any,
      after: updated as any,
    });
    return updated;
  }

  async function listEventCodes(eventId: EntityId, actor: ActorContext): Promise<EventCode[]> {
    const event = await deps.repositories.events.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    requireOrgAccess(actor, event.organizationId);
    
    return eventCodes.findActiveByEvent(eventId);
  }

  async function createScannerSession(input: ScannerSessionCreateInput, actor: ActorContext): Promise<{
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
      after: result.session as any,
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

  async function revokeSession(sessionId: EntityId, reason: string, actor: ActorContext): Promise<ScannerSession> {
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
      before: session as any,
      after: updated as any,
    });
    
    return updated;
  }

  async function scanTicket(input: ScanTicketInput, actor: ActorContext): Promise<ScanResult> {
    const event = await deps.repositories.events.findById(input.eventId);
    if (!event) throw new NotFoundError('Event', input.eventId);
    requireOrgAccess(actor, event.organizationId);
    
    // Verify session has scan permission
    const session = await validateSession(input.deviceId);
    if (!session || !canSessionScan(session)) {
      throw new ForbiddenError('Session cannot scan tickets');
    }
    
    // Check for duplicate scan
    const existing = await scanLedger.findByEventAndEntitlement(input.eventId, input.entitlementId);
    if (existing && existing.status === 'consumed') {
      const denyResult = await scanLedger.create({
        ...input,
        status: 'denied',
        denyReason: 'already_used',
        denyMessage: 'Ticket already scanned',
        guestName: null,
        guestEmail: null,
        guestPhone: null,
        admittedCount: 0,
        scanCountUsed: existing.scanCountUsed,
        scanCountAllowed: existing.scanCountAllowed,
      } as any);
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
      const denyResult = await scanLedger.create({
        ...input,
        status: 'denied',
        denyReason: 'invalid_signature',
        denyMessage: 'Entitlement not found',
        guestName: null,
        guestEmail: null,
        guestPhone: null,
        admittedCount: 0,
        scanCountUsed: null,
        scanCountAllowed: null,
      } as any);
      return {
        scan: denyResult,
        status: 'denied',
        denyReason: 'invalid_signature',
        denyMessage: 'Entitlement not found',
      };
    }
    
    // Verify entitlement belongs to event
    if (entitlement.eventId !== input.eventId) {
      const denyResult = await scanLedger.create({
        ...input,
        status: 'denied',
        denyReason: 'wrong_event',
        denyMessage: 'Ticket for different event',
        guestName: null,
        guestEmail: null,
        guestPhone: null,
        admittedCount: 0,
        scanCountUsed: null,
        scanCountAllowed: null,
      } as any);
      return {
        scan: denyResult,
        status: 'denied',
        denyReason: 'wrong_event',
        denyMessage: 'Ticket for different event',
      };
    }
    
    // Check entitlement status
    if (entitlement.status === 'void') {
      const denyResult = await scanLedger.create({
        ...input,
        status: 'denied',
        denyReason: 'void_ticket',
        denyMessage: 'Ticket is void',
        guestName: entitlement.holderName,
        guestEmail: null,
        guestPhone: null,
        admittedCount: 0,
        scanCountUsed: entitlement.scanCount,
        scanCountAllowed: entitlement.scanCountAllowed,
      } as any);
      return {
        scan: denyResult,
        status: 'denied',
        denyReason: 'void_ticket',
        denyMessage: 'Ticket is void',
      };
    }
    
    // Check if entitlement is expired (using scannedAt as proxy)
    const lastScanTime = entitlement.scannedAt && entitlement.scannedAt.length > 0 
      ? entitlement.scannedAt[entitlement.scannedAt.length - 1] 
      : null;
    if (lastScanTime && new Date(lastScanTime) < new Date()) {
      const denyResult = await scanLedger.create({
        ...input,
        status: 'denied',
        denyReason: 'expired',
        denyMessage: 'Ticket has expired',
        guestName: entitlement.holderName,
        guestEmail: null,
        guestPhone: null,
        admittedCount: 0,
        scanCountUsed: entitlement.scanCount,
        scanCountAllowed: entitlement.scanCountAllowed,
      } as any);
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
      const denyResult = await scanLedger.create({
        ...input,
        status: 'denied',
        denyReason: 'already_used',
        denyMessage: 'All scans for this ticket have been used',
        guestName: entitlement.holderName,
        guestEmail: null,
        guestPhone: null,
        admittedCount: 0,
        scanCountUsed: scansUsed,
        scanCountAllowed: scansAllowed,
      } as any);
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
    
    const scan = createScanLedger(scanInput);
    const consumed = transitionScanLedger(scan, 'consumed');
    const created = await scanLedger.create(consumed);
    
    await adminAudit.write({
      id: `audit-${created.id}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action: 'scan.consume',
      targetType: 'scan_ledger',
      targetId: created.id,
      after: created as any,
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

  async function scanMagicTicket(input: ScanMagicTicketInput, actor: ActorContext): Promise<ScanResult> {
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
    
    const entitlementId = parts[0] as EntityId;
    const timestampStr = parts[1];
    const hmac = parts[2];
    if (!timestampStr) {
      throw new InvalidOperationError('Invalid timestamp in QR payload');
    }
    const timestamp = parseInt(timestampStr, 10);
    
    // Verify HMAC (simplified - use proper crypto in production)
    const crypto = await import('crypto');
    const secret = config.magicTicketSecret ?? 'default-magic-ticket-secret-change-in-production';
    const expected = crypto.createHmac('sha256', secret)
      .update(`${entitlementId}:${timestamp}`)
      .digest('hex');
    
    if (hmac !== expected) {
      // Check previous window (±65s clock drift)
      const prevWindow = timestamp - 30;
      const prevExpected = crypto.createHmac('sha256', secret)
        .update(`${entitlementId}:${prevWindow}`)
        .digest('hex');
      
      if (hmac !== prevExpected) {
        throw new InvalidOperationError('Invalid QR signature');
      }
    }
    
    // Now scan the ticket
    return scanTicket({
      eventId: input.eventId,
      entitlementId,
      gate: input.gate,
      deviceId: input.deviceId,
      operatorUid: input.operatorUid,
      operatorName: input.operatorName,
      operatorRole: input.operatorRole,
      scannedAt: input.scannedAt,
    }, actor);
  }

  async function syncOfflineScans(scans: ScanLedgerCreateInput[], actor: ActorContext): Promise<ScanLedger[]> {
    const results: ScanLedger[] = [];
    for (const scanInput of scans) {
      const scan = createScanLedger(scanInput);
      const created = await scanLedger.create(scan);
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