import { ConflictError } from '../../domain/errors.js';
import {
  redeemTicketAccessCode,
  revokeTicketAccessCode,
} from '../../domain/models/ticket-access.js';

import type { EntityId } from '../../domain/identity.js';
import type { TicketAccessCode, TicketAccessGrant } from '../../domain/models/ticket-access.js';
import type {
  Page,
  PaginationQuery,
  TicketAccessRepository,
} from '../../domain/ports/repositories.js';

/** In-memory implementation used by focused application tests and local mode. */
export class MemoryTicketAccessRepository implements TicketAccessRepository {
  private readonly codes = new Map<EntityId, TicketAccessCode>();
  private readonly grants = new Map<EntityId, TicketAccessGrant>();

  async createCode(code: TicketAccessCode): Promise<void> {
    if (this.codes.has(code.id)) throw new ConflictError('Access code already exists');
    this.codes.set(code.id, code);
  }

  async getCodeById(codeId: EntityId): Promise<TicketAccessCode | null> {
    return this.codes.get(codeId) ?? null;
  }

  async listCodesByEvent(
    eventId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<TicketAccessCode>> {
    const all = [...this.codes.values()]
      .filter((code) => code.eventId === eventId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const start = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
    const items = all.slice(start, start + limit);
    return {
      items,
      total: all.length,
      nextCursor: start + limit < all.length ? String(start + limit) : null,
    };
  }

  async revokeCode(
    codeId: EntityId,
    actorUserId: EntityId,
    reason: string,
    now: Date,
  ): Promise<TicketAccessCode | null> {
    const code = this.codes.get(codeId);
    if (!code) return null;
    const revoked = revokeTicketAccessCode(code, actorUserId, reason, now);
    this.codes.set(codeId, revoked);
    return revoked;
  }

  async getGrantById(grantId: EntityId): Promise<TicketAccessGrant | null> {
    return this.grants.get(grantId) ?? null;
  }

  async redeem(input: {
    codeId: EntityId;
    grantId: EntityId;
    userId: EntityId;
    now: Date;
  }): Promise<{ code: TicketAccessCode; grant: TicketAccessGrant } | null> {
    const code = this.codes.get(input.codeId);
    if (!code) return null;
    const existingGrant = this.grants.get(input.grantId);
    if (existingGrant) {
      return existingGrant.userId === input.userId && existingGrant.codeId === input.codeId
        ? { code, grant: existingGrant }
        : null;
    }
    try {
      const redeemed = redeemTicketAccessCode(code, input);
      this.codes.set(input.codeId, redeemed.code);
      this.grants.set(input.grantId, redeemed.grant);
      return redeemed;
    } catch (error) {
      if (error instanceof ConflictError) return null;
      throw error;
    }
  }
}
