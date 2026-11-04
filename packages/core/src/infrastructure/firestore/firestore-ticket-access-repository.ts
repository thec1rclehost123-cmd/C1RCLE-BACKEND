import { ConflictError } from '../../domain/errors.js';
import {
  redeemTicketAccessCode,
  revokeTicketAccessCode,
} from '../../domain/models/ticket-access.js';

import { outboxDocument } from './firestore-outbox-store.js';
import { paginateUnordered } from './pagination.js';

import type { DomainEvent } from '../../domain/events.js';
import type { EntityId } from '../../domain/identity.js';
import type { TicketAccessCode, TicketAccessGrant } from '../../domain/models/ticket-access.js';
import type {
  Page,
  PaginationQuery,
  TicketAccessRepository,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const CODES = 'v2_ticket_access_codes';
const GRANTS = 'v2_ticket_access_grants';

export class FirestoreTicketAccessRepository implements TicketAccessRepository {
  constructor(private readonly db: Firestore) {}

  async createCode(code: TicketAccessCode): Promise<void> {
    const ref = this.db.collection(CODES).doc(code.id);
    await this.db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) throw new ConflictError('Access code already exists');
      tx.create(ref, code);
    });
  }

  async getCodeById(codeId: EntityId): Promise<TicketAccessCode | null> {
    const snap = await this.db.collection(CODES).doc(codeId).get();
    const data = snap.data();
    return snap.exists && data ? toAccessCode(data) : null;
  }

  async listCodesByEvent(
    eventId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<TicketAccessCode>> {
    return paginateUnordered(
      this.db.collection(CODES).where('eventId', '==', eventId),
      query,
      toAccessCode,
    );
  }

  async revokeCode(
    codeId: EntityId,
    actorUserId: EntityId,
    reason: string,
    now: Date,
  ): Promise<TicketAccessCode | null> {
    const ref = this.db.collection(CODES).doc(codeId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!snap.exists || !data) return null;
      const code = revokeTicketAccessCode(toAccessCode(data), actorUserId, reason, now);
      tx.set(ref, code);
      return code;
    });
  }

  async getGrantById(grantId: EntityId): Promise<TicketAccessGrant | null> {
    const snap = await this.db.collection(GRANTS).doc(grantId).get();
    const data = snap.data();
    return snap.exists && data ? toAccessGrant(data) : null;
  }

  async redeem(input: {
    codeId: EntityId;
    grantId: EntityId;
    userId: EntityId;
    recipientEmailHash?: string | null;
    now: Date;
    outboxEvent?: DomainEvent;
  }): Promise<{ code: TicketAccessCode; grant: TicketAccessGrant } | null> {
    const codeRef = this.db.collection(CODES).doc(input.codeId);
    const grantRef = this.db.collection(GRANTS).doc(input.grantId);
    const outboxRef = input.outboxEvent
      ? this.db.collection('v2_outbox').doc(input.outboxEvent.id)
      : null;
    return this.db.runTransaction(async (tx) => {
      const [codeSnap, grantSnap, outboxSnap] = await Promise.all([
        tx.get(codeRef),
        tx.get(grantRef),
        outboxRef ? tx.get(outboxRef) : Promise.resolve(null),
      ]);
      const rawCode = codeSnap.data();
      if (!codeSnap.exists || !rawCode) return null;
      const code = toAccessCode(rawCode);
      if (
        code.status !== 'active' ||
        Date.parse(code.startsAt) > input.now.getTime() ||
        Date.parse(code.expiresAt) <= input.now.getTime()
      ) {
        return null;
      }
      const rawGrant = grantSnap.data();
      if (grantSnap.exists && rawGrant) {
        const existing = toAccessGrant(rawGrant);
        if (existing.codeId !== code.id || existing.userId !== input.userId) return null;
        if (outboxRef && input.outboxEvent && !outboxSnap?.exists) {
          tx.create(outboxRef, outboxDocument(input.outboxEvent));
        }
        return { code, grant: existing };
      }
      try {
        const redeemed = redeemTicketAccessCode(code, input);
        tx.set(codeRef, redeemed.code);
        tx.create(grantRef, redeemed.grant);
        if (outboxRef && input.outboxEvent && !outboxSnap?.exists) {
          tx.create(outboxRef, outboxDocument(input.outboxEvent));
        }
        return redeemed;
      } catch (error) {
        if (error instanceof ConflictError) return null;
        throw error;
      }
    });
  }
}

function toAccessCode(data: DocumentData): TicketAccessCode {
  return {
    ...(data as unknown as TicketAccessCode),
    kind: data.kind === 'invitation' ? 'invitation' : 'code',
    scope: data.scope === 'event' ? 'event' : 'tiers',
    tierIds: Array.isArray(data.tierIds) ? (data.tierIds as string[]) : [],
    recipientEmailHash: (data.recipientEmailHash as string | null | undefined) ?? null,
    revokedAt: (data.revokedAt as string | null | undefined) ?? null,
    revokedBy: (data.revokedBy as string | null | undefined) ?? null,
    revokedReason: (data.revokedReason as string | null | undefined) ?? null,
  };
}

function toAccessGrant(data: DocumentData): TicketAccessGrant {
  return {
    ...(data as unknown as TicketAccessGrant),
    scope: data.scope === 'event' ? 'event' : 'tiers',
    tierIds: Array.isArray(data.tierIds) ? (data.tierIds as string[]) : [],
  };
}
