import { ConflictError, NotFoundError } from '../../domain/errors.js';
import {
  acceptWaitlistOffer,
  cancelWaitlistEntry,
  createWaitlistEntry,
  expireWaitlistOffer,
  offerWaitlistEntry,
} from '../../domain/models/waitlist-entry.js';

import type { EntityId } from '../../domain/identity.js';
import type { WaitlistEntry } from '../../domain/models/waitlist-entry.js';
import type { Page, PaginationQuery, WaitlistRepository } from '../../domain/ports/repositories.js';

export class MemoryWaitlistRepository implements WaitlistRepository {
  private readonly entries = new Map<EntityId, WaitlistEntry>();
  private readonly sequences = new Map<string, number>();

  async join(input: {
    id: EntityId;
    eventId: EntityId;
    organizationId: EntityId;
    tierId: EntityId;
    userId: EntityId;
    accessGrantId?: EntityId | null;
    eligibilityAttested?: boolean;
    now: Date;
  }) {
    const existing = [...this.entries.values()].find(
      (entry) =>
        entry.eventId === input.eventId &&
        entry.tierId === input.tierId &&
        entry.userId === input.userId &&
        (entry.status === 'waiting' || entry.status === 'offered'),
    );
    if (existing) return { entry: existing, created: false };
    const key = `${input.eventId}:${input.tierId}`;
    const sequence = (this.sequences.get(key) ?? 0) + 1;
    const entry = createWaitlistEntry({ ...input, sequence });
    this.sequences.set(key, sequence);
    this.entries.set(entry.id, entry);
    return { entry, created: true };
  }

  async getById(id: EntityId) {
    return this.entries.get(id) ?? null;
  }

  async listByUser(userId: EntityId, query: PaginationQuery): Promise<Page<WaitlistEntry>> {
    const all = [...this.entries.values()]
      .filter((entry) => entry.userId === userId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.sequence - left.sequence,
      );
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const start = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
    return {
      items: all.slice(start, start + limit),
      total: all.length,
      nextCursor: start + limit < all.length ? String(start + limit) : null,
    };
  }

  async listByEventTier(
    eventId: EntityId,
    tierId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<WaitlistEntry>> {
    const all = [...this.entries.values()]
      .filter((entry) => entry.eventId === eventId && entry.tierId === tierId)
      .sort((left, right) => left.sequence - right.sequence);
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const after = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
    const items = all.filter((entry) => entry.sequence > after).slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      total: all.length,
      nextCursor:
        last && all.some((entry) => entry.sequence > last.sequence) ? String(last.sequence) : null,
    };
  }

  async getNextWaiting(eventId: EntityId, tierId: EntityId): Promise<WaitlistEntry | null> {
    return (
      [...this.entries.values()]
        .filter(
          (entry) =>
            entry.eventId === eventId && entry.tierId === tierId && entry.status === 'waiting',
        )
        .sort((left, right) => left.sequence - right.sequence)[0] ?? null
    );
  }

  async offerNext(input: {
    eventId: EntityId;
    tierId: EntityId;
    reservationId: EntityId;
    expiresAt: string;
    now: Date;
  }) {
    const replay = [...this.entries.values()].find(
      (entry) => entry.offerReservationId === input.reservationId,
    );
    if (replay) return replay;
    const next = [...this.entries.values()]
      .filter(
        (entry) =>
          entry.eventId === input.eventId &&
          entry.tierId === input.tierId &&
          entry.status === 'waiting',
      )
      .sort((left, right) => left.sequence - right.sequence)[0];
    if (!next) return null;
    const offered = offerWaitlistEntry(next, input);
    this.entries.set(offered.id, offered);
    return offered;
  }

  async acceptOffer(input: { entryId: EntityId; userId: EntityId; now: Date }) {
    const entry = this.entries.get(input.entryId);
    if (!entry) throw new NotFoundError('waitlist_entry', input.entryId);
    if (entry.status === 'accepted' && entry.userId === input.userId) return entry;
    const accepted = acceptWaitlistOffer(entry, input);
    this.entries.set(accepted.id, accepted);
    return accepted;
  }

  async expireOffer(input: { entryId: EntityId; now: Date }) {
    const entry = this.entries.get(input.entryId);
    if (!entry) throw new NotFoundError('waitlist_entry', input.entryId);
    const expired = expireWaitlistOffer(entry, input.now);
    this.entries.set(expired.id, expired);
    return expired;
  }

  async listExpiredOffers(now: Date, limit = 100) {
    return [...this.entries.values()]
      .filter(
        (entry) =>
          (entry.status === 'offered' || entry.status === 'accepted') &&
          entry.offerExpiresAt !== null &&
          Date.parse(entry.offerExpiresAt) <= now.getTime(),
      )
      .sort(
        (left, right) =>
          (left.offerExpiresAt ?? '').localeCompare(right.offerExpiresAt ?? '') ||
          left.id.localeCompare(right.id),
      )
      .slice(0, Math.max(1, Math.min(500, limit)));
  }

  async cancel(input: { entryId: EntityId; userId: EntityId; now: Date }) {
    const entry = this.entries.get(input.entryId);
    if (!entry) throw new NotFoundError('waitlist_entry', input.entryId);
    if (entry.status === 'cancelled' && entry.userId === input.userId) return entry;
    if (entry.status === 'accepted')
      throw new ConflictError('An accepted waitlist offer cannot be cancelled');
    const cancelled = cancelWaitlistEntry(entry, input);
    this.entries.set(cancelled.id, cancelled);
    return cancelled;
  }
}
