import { createHash, randomBytes, randomInt } from 'node:crypto';

import { newVersionedEntity } from '../identity.js';

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

/** A shift, not a day: a device left unattended overnight cannot still scan. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * The only place a scanner session token is turned into its stored form.
 * Adapters and the service both call this, so a change of algorithm can
 * never leave the writer and the reader disagreeing.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

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

/**
 * Human-typeable door code. Two properties matter and neither is cosmetic:
 *
 *  - **CSPRNG, not `Math.random()`.** This string IS the door's credential —
 *    anyone holding it can open a scanner session for the event. `Math.random`
 *    is seeded predictably and is not a security primitive; a guessable door
 *    code is a guessable door.
 *  - **Unambiguous alphabet** (no `O/0`, `I/1`, `S/5`, `B/8`). Door staff read
 *    these off a phone screen in a dark club and type them into another
 *    phone. A collision-free code that gets mistyped is a support call.
 *
 * 8 characters of a 26-symbol alphabet ≈ 2^37.6 — far beyond guessing at the
 * `SENSITIVE_COMMAND` rate limit that fronts session creation, and every code
 * is additionally scoped to one organization and one event.
 */
const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXYZ2346789';

function humanDoorCode(): string {
  const chars = Array.from({ length: 8 }, () =>
    CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length)),
  );
  return `C1R-${chars.join('')}`;
}

export function createEventCode(input: EventCodeCreateInput): EventCode {
  const now = input.now ?? new Date();
  const code = humanDoorCode();
  return {
    id: `CODE-${randomBytes(16).toString('hex')}`,
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
  permissions: SessionPermissions;
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
  /**
   * The organization the session belongs to — the event code's owner, NOT the
   * staff member who opened it. This used to be set to `createdBy` (a user
   * id), which meant `session.organizationId` never matched any real tenant
   * and could not be used for a scope check; callers had to work around it at
   * the route layer. Now it is the real tenant, so a session read is
   * org-scopable on its own.
   */
  organizationId: EntityId;
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
export function createScannerSession(input: ScannerSessionCreateInput): {
  session: ScannerSession;
  sessionToken: string;
  sessionExpiresAt: string;
  sessionId: string;
} {
  const now = input.now ?? new Date();
  // CSPRNG, and the token deliberately does NOT embed the door code: a token
  // that leaks (a log line, a screenshot of a device) must not also hand over
  // the code that mints unlimited further sessions.
  const sessionToken = `scn_${randomBytes(32).toString('base64url')}`;
  const sessionId = `SESS-${randomBytes(16).toString('hex')}`;
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  const codeType = input.codeData.type;
  const permissions: SessionPermissions = {
    canScan: codeType === 'full' || codeType === 'scan_only',
    canDoorEntry: codeType === 'full',
    canWalkIn: codeType === 'full' || codeType === 'scan_only',
    canCharge: codeType === 'charge',
  };

  const session = {
    id: sessionId,
    // NEVER carried on the stored entity. The raw token is returned exactly
    // once, alongside this object, and thereafter only its SHA-256 hash
    // exists anywhere — so a database read (or a leaked backup) cannot
    // impersonate a scanner. `GET /door/sessions/:id` consequently always
    // reports `null` here.
    sessionToken: null,
    codeId: input.codeId,
    eventId: input.codeData.eventId,
    organizationId: input.organizationId,
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

export function getSessionPermissions(codeType: EventCodeType): SessionPermissions {
  return {
    canScan: codeType === 'full' || codeType === 'scan_only',
    canDoorEntry: codeType === 'full',
    canWalkIn: codeType === 'full' || codeType === 'scan_only',
    canCharge: codeType === 'charge',
  };
}

export function isSessionValid(session: { expiresAt: string; revokedAt: string | null }): boolean {
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
