import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Event Code & Scanner Session (Phase 5) ─────────────────────────────────────
 *
 * Event Codes are the authorization tokens that scanner apps use to authenticate.
 * Each code has a type that determines permissions:
 * - `full`: scan + doorEntry + walkIn
 * - `scan_only`: scan + walkIn
 * - `charge`: cover-wallet only
 *
 * Scanner sessions are short-lived tokens issued to staff devices after code validation.
 * They scope permissions to specific event/gate/device and expire after shift.
 */

export type EventCodeType = 'full' | 'scan_only' | 'charge';

export type EventCodeStatus = 'active' | 'revoked' | 'expired';

export type ScannerSessionType = 'staff' | 'device';

export interface EventCode extends VersionedEntity {
  /** Deterministic: `CODE-${randomHex}` */
  id: EntityId;
  /** Human-readable code: `C1R-XXXXXX` */
  code: string;
  eventId: EntityId;
  organizationId: EntityId;
  venueId: EntityId | null;
  /** Code type determines permissions */
  type: EventCodeType;
  /** Optional gate restriction */
  gate: string | null;
  /** Creator UID */
  createdBy: EntityId | null;
  /** Human-readable creator name */
  createdByName: string | null;
  /** Current status */
  status: EventCodeStatus;
  /** Revocation timestamp */
  revokedAt: string | null;
  /** Revocation reason */
  revokedReason: string | null;
  /** Expiry timestamp (ISO-8601) */
  expiresAt: string | null;
  /** Usage statistics */
  stats: EventCodeStats;
  /** Max concurrent devices (default 5) */
  maxDevices: number;
  /** Whether multiple devices can use same code simultaneously */
  allowReuse: boolean;
}

export interface EventCodeStats {
  /** Total scans performed with this code */
  scansCount: number;
  /** Door entries processed */
  doorEntriesCount: number;
  /** Revenue from door entries (paise) */
  doorRevenue: number;
  /** Last used timestamp */
  lastUsedAt: string | null;
  /** Active session count */
  activeSessions: number;
}

export interface EventCodeCreateInput {
  eventId: EntityId;
  organizationId: EntityId;
  venueId: EntityId | null;
  type: EventCodeType;
  gate: string | null;
  createdBy: EntityId;
  createdByName: string;
  maxDevices?: number;
  allowReuse?: boolean;
  expiresAt: string | null;
  now?: Date;
}

export function createEventCode(input: EventCodeCreateInput): any {
  const now = input.now ?? new Date();
  const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
  const code = `C1R-${randomPart}`;
  return {
    id: `CODE-${now.getTime()}-${Math.random().toString(36).substring(2, 8)}`,
    code,
    eventId: input.eventId,
    organizationId: input.organizationId,
    venueId: input.venueId,
    type: input.type,
    gate: input.gate,
    createdBy: input.createdBy,
    createdByName: input.createdByName,
    status: 'active',
    revokedAt: null,
    revokedReason: null,
    expiresAt: input.expiresAt,
    maxDevices: input.maxDevices ?? 5,
    allowReuse: input.allowReuse ?? false,
    stats: {
      scansCount: 0,
      doorEntriesCount: 0,
      doorRevenue: 0,
      lastUsedAt: null,
      activeSessions: 0,
    },
    ...newVersionedEntity(now),
  };
}

export const EVENT_CODE_STATUS: Readonly<Record<EventCodeStatus, string>> = {
  active: 'Active',
  revoked: 'Revoked',
  expired: 'Expired',
};

/**
 * Scanner Session — short-lived token for device authentication.
 * Separate from guest auth; scoped to event/code/gate/shift.
 * Permissions by type:
 * - `full` → scan + doorEntry + walkIn
 * - `scan_only` → scan + walkIn
 * - `charge` → cover-wallet only
 */
export interface ScannerSession extends VersionedEntity {
  /** Hash of session token: SHA256(token) */
  id: EntityId;
  /** The raw session token (only returned on creation) */
  sessionToken: string | null;
  /** The event code this session belongs to */
  codeId: EntityId;
  /** The event this session is for */
  eventId: EntityId;
  /** Organization context */
  organizationId: EntityId;
  /** Venue context (optional) */
  venueId: EntityId | null;
  /** Session type */
  type: ScannerSessionType;
  /** Device identifier */
  deviceId: string | null;
  /** Device name (for audit) */
  deviceName: string | null;
  /** Session expiry (ISO-8601) */
  expiresAt: string;
  /** Last activity timestamp */
  lastUsedAt: string | null;
  /** Revocation timestamp */
  revokedAt: string | null;
  /** Revocation reason */
  revokedReason: string | null;
  /** Permissions derived from code type */
  permissions: any;
  /** Session creator (staff UID) */
  createdBy: EntityId;
  /** Human-readable creator name */
  createdByName: string | null;
}

export interface SessionPermissions {
  /** Can scan tickets */
  canScan: boolean;
  /** Can process door entry (walk-in/dine-in) */
  canDoorEntry: boolean;
  /** Can process walk-in sales */
  canWalkIn: boolean;
  /** Can process cover wallet charges */
  canCharge: boolean;
}

export interface ScannerSessionCreateInput {
  codeId: EntityId;
  codeData: {
    id: EntityId;
    code: string;
    eventId: EntityId;
    venueId: EntityId | null;
    type: EventCodeType;
    gate: string | null;
    maxDevices: number;
    allowReuse: boolean;
  };
  deviceId: string;
  deviceName: string;
  createdBy: EntityId;
  createdByName: string;
  sessionType: ScannerSessionType;
  now?: Date;
}

/**
 * Creates a new scanner session with deterministic ID (hash of token).
 * Returns session with raw token (only time token is exposed).
 */
export function createScannerSession(
  input: ScannerSessionCreateInput,
): { session: any; sessionToken: string; sessionExpiresAt: string; sessionId: string } {
  const now = input.now ?? new Date();
  const sessionToken = `sess_${input.codeData.code}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const sessionId = `SESS-${input.codeId}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const expiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(); // 12 hours

  const codeType = input.codeData.type;
  const permissions: any = {
    canScan: codeType === 'full' || codeType === 'scan_only',
    canDoorEntry: codeType === 'full',
    canWalkIn: codeType === 'full' || codeType === 'scan_only',
    canCharge: codeType === 'charge',
  };

  const session = {
    id: sessionId,
    sessionToken,
    codeId: input.codeId,
    eventId: input.codeData.eventId,
    organizationId: input.createdBy,
    venueId: input.codeData.venueId,
    type: input.sessionType,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    expiresAt,
    lastUsedAt: new Date().toISOString(),
    revokedAt: null,
    revokedReason: null,
    permissions,
    createdBy: input.createdBy,
    createdByName: input.createdByName,
    ...newVersionedEntity(now),
  };

  return {
    session,
    sessionToken,
    sessionExpiresAt: expiresAt,
    sessionId,
  };
}

export function getSessionPermissions(codeType: any): any {
  return {
    canScan: codeType === 'full' || codeType === 'scan_only',
    canDoorEntry: codeType === 'full',
    canWalkIn: codeType === 'full' || codeType === 'scan_only',
    canCharge: codeType === 'charge',
  };
}

export function isSessionValid(session: {
  expiresAt: string;
  revokedAt: string | null;
}): boolean {
  if (session.revokedAt) return false;
  if (new Date(session.expiresAt) < new Date()) return false;
  return true;
}

export function canSessionScan(session: { permissions: { canScan: boolean } }): boolean {
  return session.permissions.canScan;
}

export function canSessionDoorEntry(session: { permissions: { canDoorEntry: boolean } }): boolean {
  return session.permissions.canDoorEntry;
}

export function canSessionWalkIn(session: { permissions: { canWalkIn: boolean } }): boolean {
  return session.permissions.canWalkIn;
}

export function canSessionCharge(session: { permissions: { canCharge: boolean } }): boolean {
  return session.permissions.canCharge;
}