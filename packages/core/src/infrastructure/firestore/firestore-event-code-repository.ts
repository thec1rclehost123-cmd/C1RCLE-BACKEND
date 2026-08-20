import { compareAndSet } from './compare-and-set.js';
import { paginateQuery } from './pagination.js';
import { createEventCode, createScannerSession } from '../../domain/models/event-code.js';

import type { EntityId } from '../../domain/identity.js';
import type { EventCode, EventCodeStatus, EventCodeCreateInput, ScannerSession, ScannerSessionCreateInput } from '../../domain/models/event-code.js';
import type {
  EventCodeRepository,
  ScannerSessionRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';

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
    return snap.exists ? toEventCode(snap.data()!) : null;
  }

  async findByCode(code: string): Promise<EventCode | null> {
    const snap = await this.collection.where('code', '==', code).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return doc ? toEventCode(doc.data()) : null;
  }

  async findByEvent(eventId: EntityId, input: PaginationQuery): Promise<any> {
    const base = this.collection.where('eventId', '==', eventId).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toEventCode);
  }

  async findByOrganization(organizationId: EntityId, input: PaginationQuery): Promise<any> {
    const base = this.collection.where('organizationId', '==', organizationId).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toEventCode);
  }

  async findActiveByEvent(eventId: EntityId): Promise<any[]> {
    const snap = await this.collection
      .where('eventId', '==', eventId)
      .where('status', '==', 'active')
      .get();
    return snap.docs.map((doc) => toEventCode(doc.data()));
  }

  async updateStatus(id: EntityId, status: 'active' | 'revoked' | 'expired', revokedReason?: string): Promise<any | null> {
    const ref = this.collection.doc(id);
    const updates: Record<string, unknown> = { status, updatedAt: new Date().toISOString() };
    if (revokedReason) updates.revokedReason = revokedReason;
    if (status === 'revoked') updates.revokedAt = new Date().toISOString();
    await ref.update(updates);
    const snap = await ref.get();
    return snap.exists ? toEventCode(snap.data()!) : null;
  }

  async revoke(id: EntityId, reason: string): Promise<any | null> {
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

  async create(input: ScannerSessionCreateInput): Promise<{ session: any; sessionToken: string; sessionExpiresAt: string; sessionId: string }> {
    const result = createScannerSession(input);
    await this.sessionsCollection.doc(result.session.id).set(toSessionDoc(result.session));
    const crypto = await import('crypto');
    const tokenHash = crypto.createHash('sha256').update(result.sessionToken).digest('hex');
    await this.tokensCollection.doc(tokenHash).set({ sessionId: result.session.id });
    return result;
  }

  async findById(id: EntityId): Promise<any | null> {
    const snap = await this.db.collection(SESSIONS_COLLECTION).doc(id).get();
    return snap.exists ? toSession(snap.data()!) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<any | null> {
    const tokenDoc = await this.tokensCollection.doc(tokenHash).get();
    if (!tokenDoc.exists) return null;
    const sessionId = tokenDoc.data()!.sessionId;
    const snap = await this.db.collection(SESSIONS_COLLECTION).doc(sessionId).get();
    return snap.exists ? toSession(snap.data()!) : null;
  }

  async findByCode(codeId: EntityId, input: PaginationQuery): Promise<any> {
    const base = this.db.collection(SESSIONS_COLLECTION).where('codeId', '==', codeId).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toSession);
  }

  async findActiveByCode(codeId: EntityId): Promise<any[]> {
    const now = new Date().toISOString();
    const snap = await this.db.collection(SESSIONS_COLLECTION)
      .where('codeId', '==', codeId)
      .where('revokedAt', '==', null)
      .where('expiresAt', '>', now)
      .get();
    return snap.docs.map((doc) => toSession(doc.data()));
  }

  async findByDevice(deviceId: string, input: PaginationQuery): Promise<any> {
    const base = this.db.collection(SESSIONS_COLLECTION).where('deviceId', '==', deviceId).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toSession);
  }

  async updateLastUsed(id: EntityId): Promise<void> {
    await this.db.collection(SESSIONS_COLLECTION).doc(id).update({ lastUsedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }

  async revoke(id: EntityId, reason: string): Promise<any | null> {
    const ref = this.db.collection(SESSIONS_COLLECTION).doc(id);
    await ref.update({ revokedAt: new Date().toISOString(), revokedReason: reason, updatedAt: new Date().toISOString() });
    const snap = await ref.get();
    return snap.exists ? toSession(snap.data()!) : null;
  }

  async cleanupExpired(): Promise<number> {
    const now = new Date().toISOString();
    const snap = await this.db.collection(SESSIONS_COLLECTION)
      .where('revokedAt', '==', null)
      .where('expiresAt', '<=', now)
      .get();
    const batch = this.db.batch();
    let count = 0;
    for (const doc of snap.docs) {
      batch.update(doc.ref, { revokedAt: new Date().toISOString(), revokedReason: 'expired', updatedAt: new Date().toISOString() });
      count++;
    }
    if (count > 0) await batch.commit();
    return count;
  }
}

function toDoc(code: any): DocumentData {
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

function toEventCode(data: DocumentData): any {
  return {
    id: data.id as string,
    code: data.code as string,
    eventId: data.eventId as string,
    organizationId: data.organizationId as string,
    venueId: data.venueId as string | null,
    type: data.type as 'full' | 'scan_only' | 'charge',
    gate: data.gate as string | null,
    createdBy: data.createdBy as string | null,
    createdByName: data.createdByName as string | null,
    status: data.status as 'active' | 'revoked' | 'expired',
    revokedAt: data.revokedAt as string | null,
    revokedReason: data.revokedReason as string | null,
    expiresAt: data.expiresAt as string | null,
    maxDevices: data.maxDevices as number,
    allowReuse: data.allowReuse as boolean,
    stats: {
      scansCount: data.stats?.scansCount as number ?? 0,
      doorEntriesCount: data.stats?.doorEntriesCount as number ?? 0,
      doorRevenue: data.stats?.doorRevenue as number ?? 0,
      lastUsedAt: data.stats?.lastUsedAt as string | null,
      activeSessions: data.stats?.activeSessions as number ?? 0,
    },
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}

function toSessionDoc(session: any): DocumentData {
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

function toSession(data: DocumentData): any {
  return {
    id: data.id as string,
    sessionToken: data.sessionToken as string | null,
    codeId: data.codeId as string,
    eventId: data.eventId as string,
    organizationId: data.organizationId as string,
    venueId: data.venueId as string | null,
    type: data.type as 'staff' | 'device',
    deviceId: data.deviceId as string | null,
    deviceName: data.deviceName as string | null,
    expiresAt: data.expiresAt as string,
    lastUsedAt: data.lastUsedAt as string | null,
    revokedAt: data.revokedAt as string | null,
    revokedReason: data.revokedReason as string | null,
    permissions: data.permissions as { canScan: boolean; canDoorEntry: boolean; canWalkIn: boolean; canCharge: boolean },
    createdBy: data.createdBy as string,
    createdByName: data.createdByName as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}