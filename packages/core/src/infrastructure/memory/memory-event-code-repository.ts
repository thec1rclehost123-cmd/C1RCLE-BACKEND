import { VersionConflictError } from '../../domain/errors.js';
import { createEventCode } from '../../domain/models/event-code.js';

import type { EntityId } from '../../domain/identity.js';
import type { EventCode, EventCodeStatus, EventCodeCreateInput, ScannerSession, ScannerSessionCreateInput } from '../../domain/models/event-code.js';
import type {
  EventCodeRepository,
  ScannerSessionRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';

/**
 * In-memory Event Code and Scanner Session repository for testing and development.
 */
function casSet<T extends { id: EntityId; version: number }>(
  map: Map<EntityId, T>,
  entity: T,
): void {
  const existing = map.get(entity.id);
  if (existing && existing.version !== entity.version - 1) {
    throw new VersionConflictError(entity.version - 1, existing.version);
  }
  map.set(entity.id, entity);
}

function serializeSlice<T>(all: T[], query: any): any {
  const { cursor, limit } = query;
  const start = cursor ? all.findIndex((item: any) => item.id === cursor) + 1 : 0;
  const end = Math.min(start + limit, all.length);
  const items = all.slice(start, end);
  const nextCursor = end < all.length && items.length > 0 ? (items[items.length - 1] as any).id : null;
  return { items, total: all.length, nextCursor };
}

export class MemoryEventCodeRepository implements EventCodeRepository {
  codes = new Map<EntityId, EventCode>();
  byCode = new Map<string, EntityId>();

  async create(input: EventCodeCreateInput): Promise<EventCode> {
    const code = createEventCode(input);
    casSet(this.codes, code);
    this.byCode.set(code.code, code.id);
    return code;
  }

  async findById(id: EntityId): Promise<EventCode | null> {
    return this.codes.get(id) ?? null;
  }

  async findByCode(code: string): Promise<EventCode | null> {
    const id = this.byCode.get(code);
    if (!id) return null;
    return this.codes.get(id) ?? null;
  }

  async findByEvent(eventId: EntityId, input: PaginationQuery): Promise<any> {
    const all = [...this.codes.values()].filter((c) => c.eventId === eventId);
    return serializeSlice(all, input);
  }

  async findByOrganization(organizationId: EntityId, input: PaginationQuery): Promise<any> {
    const all = [...this.codes.values()].filter((c) => c.organizationId === organizationId);
    return serializeSlice(all, input);
  }

  async findActiveByEvent(eventId: EntityId): Promise<EventCode[]> {
    return [...this.codes.values()].filter((c) => c.eventId === eventId && c.status === 'active');
  }

  async updateStatus(id: EntityId, status: EventCodeStatus, revokedReason?: string): Promise<EventCode | null> {
    const code = this.codes.get(id);
    if (!code) return null;
    const updated = { ...code, status, revokedReason: revokedReason ?? code.revokedReason, revokedAt: status === 'revoked' ? new Date().toISOString() : code.revokedAt, version: code.version + 1, updatedAt: new Date().toISOString() };
    this.codes.set(id, updated);
    return updated;
  }

  async revoke(id: EntityId, reason: string): Promise<EventCode | null> {
    return this.updateStatus(id, 'revoked', reason);
  }

  async incrementScanCount(id: EntityId): Promise<void> {
    const code = this.codes.get(id);
    if (code) {
      code.stats.scansCount++;
      code.version++;
      code.updatedAt = new Date().toISOString();
      this.codes.set(id, code);
    }
  }

  async incrementDoorEntry(id: EntityId, amountPaise: number): Promise<void> {
    const code = this.codes.get(id);
    if (code) {
      code.stats.doorEntriesCount++;
      code.stats.doorRevenue += amountPaise;
      code.version++;
      code.updatedAt = new Date().toISOString();
      this.codes.set(id, code);
    }
  }

  async updateLastUsed(id: EntityId): Promise<void> {
    const code = this.codes.get(id);
    if (code) {
      code.stats.lastUsedAt = new Date().toISOString();
      code.version++;
      code.updatedAt = new Date().toISOString();
      this.codes.set(id, code);
    }
  }

  async adjustActiveSessions(id: EntityId, delta: number): Promise<void> {
    const code = this.codes.get(id);
    if (code) {
      code.stats.activeSessions = Math.max(0, code.stats.activeSessions + delta);
      code.version++;
      code.updatedAt = new Date().toISOString();
      this.codes.set(id, code);
    }
  }
}

import { createScannerSession } from '../../domain/models/event-code.js';

export class MemoryScannerSessionRepository implements ScannerSessionRepository {
  sessions = new Map<EntityId, any>();
  byTokenHash = new Map<string, EntityId>();

  async create(input: ScannerSessionCreateInput): Promise<{ session: any; sessionToken: string; sessionExpiresAt: string; sessionId: string }> {
    const result = createScannerSession(input);
    this.sessions.set(result.session.id, result.session);
    const crypto = await import('crypto');
    const tokenHash = crypto.createHash('sha256').update(result.sessionToken).digest('hex');
    this.byTokenHash.set(tokenHash, result.session.id);
    return result;
  }

  async findById(id: EntityId): Promise<any | null> {
    return this.sessions.get(id) ?? null;
  }

  async findByTokenHash(tokenHash: string): Promise<any | null> {
    const id = this.byTokenHash.get(tokenHash);
    if (!id) return null;
    return this.sessions.get(id) ?? null;
  }

  async findByCode(codeId: EntityId, input: any): Promise<any> {
    const all = [...this.sessions.values()].filter((s) => s.codeId === codeId);
    return serializeSlice(all, input);
  }

  async findActiveByCode(codeId: EntityId): Promise<any[]> {
    const now = new Date();
    return [...this.sessions.values()].filter((s) => s.codeId === codeId && !s.revokedAt && new Date(s.expiresAt) > now);
  }

  async findByDevice(deviceId: string, input: any): Promise<any> {
    const all = [...this.sessions.values()].filter((s) => s.deviceId === deviceId);
    return serializeSlice(all, input);
  }

  async updateLastUsed(id: EntityId): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      session.lastUsedAt = new Date().toISOString();
      session.version++;
      session.updatedAt = new Date().toISOString();
      this.sessions.set(id, session);
    }
  }

  async revoke(id: EntityId, reason: string): Promise<any | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    const updated = { ...session, revokedAt: new Date().toISOString(), revokedReason: reason, version: session.version + 1, updatedAt: new Date().toISOString() };
    this.sessions.set(id, updated);
    return updated;
  }

  async cleanupExpired(): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;
    for (const [id, session] of this.sessions) {
      if (!session.revokedAt && new Date(session.expiresAt) <= new Date()) {
        session.revokedAt = new Date().toISOString();
        session.revokedReason = 'expired';
        session.version++;
        session.updatedAt = new Date().toISOString();
        this.sessions.set(id, session);
        count++;
      }
    }
    return count;
  }
}