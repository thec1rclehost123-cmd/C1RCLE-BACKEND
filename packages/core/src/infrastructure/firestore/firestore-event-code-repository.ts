import { FieldValue } from 'firebase-admin/firestore';

import { createEventCode, createScannerSession } from '../../domain/models/event-code.js';

import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  EventCode,
  EventCodeCreateInput,
  EventCodeStats,
  EventCodeStatus,
  ScannerSession,
  ScannerSessionCreateInput,
  SessionPermissions,
} from '../../domain/models/event-code.js';
import type {
  EventCodeRepository,
  ScannerSessionRepository,
  Page,
  PaginationQuery,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const CODES_COLLECTION = 'v2_event_codes';
const SESSIONS_COLLECTION = 'v2_scanner_sessions';
const TOKENS_COLLECTION = 'v2_scanner_session_tokens';

export class FirestoreEventCodeRepository implements EventCodeRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(CODES_COLLECTION);
  }

  async create(input: EventCodeCreateInput): Promise<EventCode> {
    const code = createEventCode(input);
    await this.collection.doc(code.id).set(toDoc(code));
    return code;
  }

  async findById(id: EntityId): Promise<EventCode | null> {
    const snap = await this.collection.doc(id).get();
    const data = snap.data();
    return data ? toEventCode(data) : null;
  }

  async findByCode(code: string): Promise<EventCode | null> {
    const snap = await this.collection.where('code', '==', code).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return doc ? toEventCode(doc.data()) : null;
  }

  async findByEvent(eventId: EntityId, input: PaginationQuery): Promise<Page<EventCode>> {
    const base = this.collection.where('eventId', '==', eventId).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toEventCode);
  }

  async findByOrganization(
    organizationId: EntityId,
    input: PaginationQuery,
  ): Promise<Page<EventCode>> {
    const base = this.collection
      .where('organizationId', '==', organizationId)
      .orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toEventCode);
  }

  async findActiveByEvent(eventId: EntityId): Promise<EventCode[]> {
    const snap = await this.collection
      .where('eventId', '==', eventId)
      .where('status', '==', 'active')
      .get();
    return snap.docs.map((doc) => toEventCode(doc.data()));
  }

  async updateStatus(
    id: EntityId,
    status: EventCodeStatus,
    revokedReason?: string,
  ): Promise<EventCode | null> {
    const ref = this.collection.doc(id);
    const updates: Record<string, unknown> = { status, updatedAt: new Date().toISOString() };
    if (revokedReason) updates.revokedReason = revokedReason;
    if (status === 'revoked') updates.revokedAt = new Date().toISOString();
    await ref.update(updates);
    const snap = await ref.get();
    const data = snap.data();
    return data ? toEventCode(data) : null;
  }

  async revoke(id: EntityId, reason: string): Promise<EventCode | null> {
    return this.updateStatus(id, 'revoked', reason);
  }

  async incrementScanCount(id: EntityId): Promise<void> {
    await this.collection.doc(id).update({
      'stats.scansCount': FieldValue.increment(1),
      updatedAt: new Date().toISOString(),
    });
  }

  async incrementDoorEntry(id: EntityId, amountPaise: number): Promise<void> {
    await this.collection.doc(id).update({
      'stats.doorEntriesCount': FieldValue.increment(1),
      'stats.doorRevenue': FieldValue.increment(amountPaise),
      updatedAt: new Date().toISOString(),
    });
  }

  async updateLastUsed(id: EntityId): Promise<void> {
    await this.collection.doc(id).update({
      'stats.lastUsedAt': new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  async adjustActiveSessions(id: EntityId, delta: number): Promise<void> {
    await this.collection.doc(id).update({
      'stats.activeSessions': FieldValue.increment(delta),
      updatedAt: new Date().toISOString(),
    });
  }
}

export class FirestoreScannerSessionRepository implements ScannerSessionRepository {
  constructor(private readonly db: Firestore) {}

  private get sessionsCollection() {
    return this.db.collection(SESSIONS_COLLECTION);
  }

  private get tokensCollection() {
    return this.db.collection(TOKENS_COLLECTION);
  }

  async create(input: ScannerSessionCreateInput): Promise<{
    session: ScannerSession;
    sessionToken: string;
    sessionExpiresAt: string;
    sessionId: string;
  }> {
    const result = createScannerSession(input);
    await this.sessionsCollection.doc(result.session.id).set(toSessionDoc(result.session));
    const crypto = await import('crypto');
    const tokenHash = crypto.createHash('sha256').update(result.sessionToken).digest('hex');
    await this.tokensCollection.doc(tokenHash).set({ sessionId: result.session.id });
    return result;
  }

  async findById(id: EntityId): Promise<ScannerSession | null> {
    const snap = await this.db.collection(SESSIONS_COLLECTION).doc(id).get();
    const data = snap.data();
    return data ? toSession(data) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<ScannerSession | null> {
    const tokenDoc = await this.tokensCollection.doc(tokenHash).get();
    const tokenData = tokenDoc.data();
    if (!tokenData) return null;
    const sessionId = tokenData.sessionId as EntityId;
    const snap = await this.db.collection(SESSIONS_COLLECTION).doc(sessionId).get();
    const data = snap.data();
    return data ? toSession(data) : null;
  }

  async findByCode(codeId: EntityId, input: PaginationQuery): Promise<Page<ScannerSession>> {
    const base = this.db
      .collection(SESSIONS_COLLECTION)
      .where('codeId', '==', codeId)
      .orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toSession);
  }

  async findActiveByCode(codeId: EntityId): Promise<ScannerSession[]> {
    const now = new Date().toISOString();
    const snap = await this.db
      .collection(SESSIONS_COLLECTION)
      .where('codeId', '==', codeId)
      .where('revokedAt', '==', null)
      .where('expiresAt', '>', now)
      .get();
    return snap.docs.map((doc) => toSession(doc.data()));
  }

  async findByDevice(deviceId: string, input: PaginationQuery): Promise<Page<ScannerSession>> {
    const base = this.db
      .collection(SESSIONS_COLLECTION)
      .where('deviceId', '==', deviceId)
      .orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toSession);
  }

  async updateLastUsed(id: EntityId): Promise<void> {
    await this.db
      .collection(SESSIONS_COLLECTION)
      .doc(id)
      .update({ lastUsedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }

  async revoke(id: EntityId, reason: string): Promise<ScannerSession | null> {
    const ref = this.db.collection(SESSIONS_COLLECTION).doc(id);
    await ref.update({
      revokedAt: new Date().toISOString(),
      revokedReason: reason,
      updatedAt: new Date().toISOString(),
    });
    const snap = await ref.get();
    const data = snap.data();
    return data ? toSession(data) : null;
  }

  async cleanupExpired(): Promise<number> {
    const now = new Date().toISOString();
    const snap = await this.db
      .collection(SESSIONS_COLLECTION)
      .where('revokedAt', '==', null)
      .where('expiresAt', '<=', now)
      .get();
    const batch = this.db.batch();
    let count = 0;
    for (const doc of snap.docs) {
      batch.update(doc.ref, {
        revokedAt: new Date().toISOString(),
        revokedReason: 'expired',
        updatedAt: new Date().toISOString(),
      });
      count++;
    }
    if (count > 0) await batch.commit();
    return count;
  }
}

function toDoc(code: EventCode): DocumentData {
  return {
    id: code.id,
    code: code.code,
    eventId: code.eventId,
    organizationId: code.organizationId,
    venueId: code.venueId,
    type: code.type,
    gate: code.gate,
    createdBy: code.createdBy,
    createdByName: code.createdByName,
    status: code.status,
    revokedAt: code.revokedAt,
    revokedReason: code.revokedReason,
    expiresAt: code.expiresAt,
    maxDevices: code.maxDevices,
    allowReuse: code.allowReuse,
    stats: code.stats,
    version: code.version,
    createdAt: code.createdAt,
    updatedAt: code.updatedAt,
  };
}

function toEventCode(data: DocumentData): EventCode {
  const stats = data.stats as Partial<EventCodeStats> | undefined;
  return {
    id: data.id as string,
    code: data.code as string,
    eventId: data.eventId as string,
    organizationId: data.organizationId as string,
    venueId: data.venueId as string | null,
    type: data.type as EventCode['type'],
    gate: data.gate as string | null,
    createdBy: data.createdBy as string | null,
    createdByName: data.createdByName as string | null,
    status: data.status as EventCodeStatus,
    revokedAt: data.revokedAt as string | null,
    revokedReason: data.revokedReason as string | null,
    expiresAt: data.expiresAt as string | null,
    maxDevices: data.maxDevices as number,
    allowReuse: data.allowReuse as boolean,
    stats: {
      scansCount: stats?.scansCount ?? 0,
      doorEntriesCount: stats?.doorEntriesCount ?? 0,
      doorRevenue: stats?.doorRevenue ?? 0,
      lastUsedAt: stats?.lastUsedAt ?? null,
      activeSessions: stats?.activeSessions ?? 0,
    },
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}

function toSessionDoc(session: ScannerSession): DocumentData {
  return {
    id: session.id,
    sessionToken: session.sessionToken,
    codeId: session.codeId,
    eventId: session.eventId,
    organizationId: session.organizationId,
    venueId: session.venueId,
    type: session.type,
    deviceId: session.deviceId,
    deviceName: session.deviceName,
    expiresAt: session.expiresAt,
    lastUsedAt: session.lastUsedAt,
    revokedAt: session.revokedAt,
    revokedReason: session.revokedReason,
    permissions: session.permissions,
    createdBy: session.createdBy,
    createdByName: session.createdByName,
    version: session.version,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function toSession(data: DocumentData): ScannerSession {
  return {
    id: data.id as string,
    sessionToken: data.sessionToken as string | null,
    codeId: data.codeId as string,
    eventId: data.eventId as string,
    organizationId: data.organizationId as string,
    venueId: data.venueId as string | null,
    type: data.type as ScannerSession['type'],
    deviceId: data.deviceId as string | null,
    deviceName: data.deviceName as string | null,
    expiresAt: data.expiresAt as string,
    lastUsedAt: data.lastUsedAt as string | null,
    revokedAt: data.revokedAt as string | null,
    revokedReason: data.revokedReason as string | null,
    permissions: data.permissions as SessionPermissions,
    createdBy: data.createdBy as string,
    createdByName: data.createdByName as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
