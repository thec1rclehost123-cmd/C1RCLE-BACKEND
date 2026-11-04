import { ConflictError, InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { newVersionedEntity } from '../../domain/identity.js';
import {
  confirmEventCoverRedemptionChallenge,
  consumeEventCoverRedemptionChallenge,
  expireEventCoverRedemptionChallenge,
  freezeUnusedEventCoverForRefund,
  releaseUnusedEventCoverRefundFreeze,
  captureEventCoverReservation,
  assertEventCoverAccountForIssuance,
  eventCoverAccountId,
  eventCoverEntryId,
  transferEventCoverHolder,
  reserveEventCover,
  reverseEventCoverCapture,
  voidEventCoverReservation,
  refundUnusedEventCover,
} from '../../domain/models/event-cover.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  EventCoverAccount,
  EventCoverEntry,
  EventCoverRedemptionChallenge,
} from '../../domain/models/event-cover.js';
import type {
  EventCoverAccountRepository,
  Page,
  PaginationQuery,
} from '../../domain/ports/repositories.js';

/** In-memory transactional analogue used by deterministic service tests. */
export class MemoryEventCoverAccountRepository implements EventCoverAccountRepository {
  private readonly accounts = new Map<EntityId, EventCoverAccount>();
  private readonly entries = new Map<EntityId, EventCoverEntry>();
  private readonly challenges = new Map<EntityId, EventCoverRedemptionChallenge>();
  private readonly consumingChallenges = new Set<EntityId>();

  async createIssuedAccount(account: EventCoverAccount): Promise<EventCoverAccount> {
    assertEventCoverAccountForIssuance(account);
    const current = this.accounts.get(account.id);
    const issuanceId = eventCoverEntryId(account.id, account.entitlementId, 'issuance');
    const existingEntry = this.entries.get(issuanceId);
    if (current) {
      if (
        !existingEntry ||
        !sameIssuance(current, account) ||
        !issuanceEntryMatches(existingEntry, current)
      ) {
        throw new ConflictError('Event cover account already exists with different issuance terms');
      }
      return current;
    }
    const now = new Date(account.createdAt);
    const entry: EventCoverEntry = {
      ...newVersionedEntity(now),
      id: issuanceId,
      accountId: account.id,
      entitlementId: account.entitlementId,
      orderId: account.orderId,
      eventId: account.eventId,
      venueOrganizationId: account.venueOrganizationId,
      type: 'issuance',
      amountPaise: account.issuedPaise,
      operationId: account.entitlementId,
      actorUserId: null,
      terminalId: null,
      receiptReference: null,
      policyVersion: account.policyVersion,
      reversesEntryId: null,
    };
    this.accounts.set(account.id, account);
    this.entries.set(entry.id, entry);
    return account;
  }

  async getByEntitlement(entitlementId: EntityId): Promise<EventCoverAccount | null> {
    return this.accounts.get(eventCoverAccountId(entitlementId)) ?? null;
  }

  async listByEvent(eventId: EntityId, query: PaginationQuery): Promise<Page<EventCoverAccount>> {
    const all = [...this.accounts.values()].filter((account) => account.eventId === eventId);
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const start = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
    const items = all.slice(start, start + limit);
    return {
      items,
      total: all.length,
      nextCursor: start + items.length < all.length ? String(start + items.length) : null,
    };
  }

  async transferHolder(
    entitlementId: EntityId,
    expectedCurrentHolderId: EntityId | null,
    nextHolderId: EntityId,
    now = new Date(),
  ) {
    const accountId = eventCoverAccountId(entitlementId);
    const account = this.accounts.get(accountId);
    if (!account) return null;
    const transferred = transferEventCoverHolder(
      account,
      expectedCurrentHolderId,
      nextHolderId,
      now,
    );
    this.accounts.set(accountId, transferred);
    return transferred;
  }

  async listEntries(accountId: EntityId): Promise<EventCoverEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.accountId === accountId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createRedemptionChallenge(challenge: EventCoverRedemptionChallenge) {
    const current = this.challenges.get(challenge.id);
    if (current) {
      if (!sameChallenge(current, challenge)) {
        throw new ConflictError('Cover redemption challenge id is already used');
      }
      return current;
    }
    const account = this.requireAccount(challenge.accountId);
    const reservation = reserveEventCover(account, {
      amountPaise: challenge.amountPaise,
      operationId: challenge.id,
      guestConfirmed: false,
      authorizationOnly: true,
      online: true,
      actorUserId: challenge.initiatedByUserId,
      terminalId: challenge.terminalId,
      receiptReference: challenge.receiptReference,
      now: new Date(challenge.createdAt),
    });
    this.accounts.set(account.id, reservation.account);
    this.entries.set(reservation.entry.id, reservation.entry);
    this.challenges.set(challenge.id, challenge);
    return challenge;
  }

  async getRedemptionChallenge(challengeId: EntityId) {
    return this.challenges.get(challengeId) ?? null;
  }

  async expireRedemptionChallenge(challengeId: EntityId, now = new Date()) {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new NotFoundError('Cover redemption challenge', challengeId);
    if (challenge.status === 'expired') return challenge;
    const expired = expireEventCoverRedemptionChallenge(challenge, now);
    const account = this.requireAccount(challenge.accountId);
    const reserve = this.entries.get(eventCoverEntryId(account.id, challenge.id, 'reserve'));
    if (!reserve) throw new InvalidOperationError('Expired cover request has no reservation');
    const priorEntries = [...this.entries.values()].filter(
      (entry) => entry.accountId === account.id,
    );
    const voided = voidEventCoverReservation(account, reserve, priorEntries, now);
    this.accounts.set(account.id, voided.account);
    this.entries.set(voided.entry.id, voided.entry);
    this.challenges.set(challengeId, expired);
    return expired;
  }

  async cleanupExpiredRedemptionChallenges(now: Date, limit = 100) {
    const expired = [...this.challenges.values()]
      .filter(
        (challenge) =>
          (challenge.status === 'pending' || challenge.status === 'confirmed') &&
          Date.parse(challenge.expiresAt) <= now.getTime(),
      )
      .slice(0, limit);
    for (const challenge of expired) {
      await this.expireRedemptionChallenge(challenge.id, now);
    }
    return expired.length;
  }

  async confirmRedemptionChallenge(challengeId: EntityId, guestUserId: EntityId, now = new Date()) {
    const current = this.challenges.get(challengeId);
    if (!current) throw new NotFoundError('Cover redemption challenge', challengeId);
    if (current.status === 'confirmed') {
      if (current.guestUserId !== guestUserId)
        throw new NotFoundError('Cover redemption challenge', challengeId);
      return current;
    }
    const confirmed = confirmEventCoverRedemptionChallenge(current, guestUserId, now);
    this.challenges.set(challengeId, confirmed);
    return confirmed;
  }

  async consumeConfirmedRedemption(challengeId: EntityId, venueUserId: EntityId, now = new Date()) {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new NotFoundError('Cover redemption challenge', challengeId);
    if (challenge.status === 'consumed') {
      const account = this.requireAccount(challenge.accountId);
      const entry = this.entries.get(eventCoverEntryId(account.id, challenge.id, 'capture'));
      if (!entry) throw new InvalidOperationError('Consumed cover redemption has no capture fact');
      return { account, entry };
    }
    if (
      challenge.status !== 'confirmed' ||
      challenge.initiatedByUserId !== venueUserId ||
      Date.parse(challenge.expiresAt) <= now.getTime() ||
      this.consumingChallenges.has(challengeId)
    ) {
      throw new InvalidOperationError('Cover redemption is not confirmed or has expired');
    }
    this.consumingChallenges.add(challengeId);
    try {
      const captured = await this.capture(challenge.accountId, challenge.id, now);
      this.challenges.set(challengeId, consumeEventCoverRedemptionChallenge(challenge, now));
      return captured;
    } finally {
      this.consumingChallenges.delete(challengeId);
    }
  }

  async reserve(accountId: EntityId, input: Parameters<EventCoverAccountRepository['reserve']>[1]) {
    const account = this.requireAccount(accountId);
    const id = eventCoverEntryId(accountId, input.operationId, 'reserve');
    const existing = this.entries.get(id);
    if (existing) {
      if (
        existing.amountPaise !== input.amountPaise ||
        existing.actorUserId !== input.actorUserId ||
        existing.terminalId !== input.terminalId ||
        existing.receiptReference !== input.receiptReference.trim()
      ) {
        throw new ConflictError('Event cover operation id is already used');
      }
      return { account, entry: existing, replayed: true };
    }
    const transition = reserveEventCover(account, input);
    this.accounts.set(accountId, transition.account);
    this.entries.set(transition.entry.id, transition.entry);
    return { ...transition, replayed: false };
  }

  async capture(accountId: EntityId, operationId: EntityId, now?: Date) {
    return this.resolve(accountId, operationId, 'capture', now);
  }

  async void(accountId: EntityId, operationId: EntityId, now?: Date) {
    return this.resolve(accountId, operationId, 'void', now);
  }

  async freezeForRefund(
    entitlementIds: readonly EntityId[],
    refundRequestId: EntityId,
    now = new Date(),
  ) {
    const accounts = entitlementIds
      .map((id) => this.accounts.get(eventCoverAccountId(id)))
      .filter((account): account is EventCoverAccount => account !== undefined);
    const frozen = accounts.map((account) =>
      freezeUnusedEventCoverForRefund(account, refundRequestId, now),
    );
    for (const account of frozen) this.accounts.set(account.id, account);
    return frozen;
  }

  async releaseRefundFreeze(
    entitlementIds: readonly EntityId[],
    refundRequestId: EntityId,
    now = new Date(),
  ) {
    const transitions: EventCoverAccount[] = [];
    for (const entitlementId of entitlementIds) {
      const account = this.accounts.get(eventCoverAccountId(entitlementId));
      if (!account) continue;
      if (account.status === 'active' && account.refundRequestId == null) continue;
      transitions.push(releaseUnusedEventCoverRefundFreeze(account, refundRequestId, now));
    }
    for (const account of transitions) this.accounts.set(account.id, account);
  }

  async refundUnused(
    accountId: EntityId,
    input: {
      operationId: EntityId;
      actorUserId: EntityId;
      refundRequestId: EntityId;
      now?: Date;
    },
  ) {
    const account = this.requireAccount(accountId);
    const entryId = eventCoverEntryId(accountId, input.operationId, 'refund');
    const existing = this.entries.get(entryId);
    if (existing) {
      if (!refundEntryMatches(existing, account, input)) {
        throw new ConflictError('Event cover refund operation id is already used');
      }
      return { account, entry: existing, replayed: true };
    }
    const transition = refundUnusedEventCover(account, input);
    this.accounts.set(accountId, transition.account);
    this.entries.set(transition.entry.id, transition.entry);
    return { ...transition, replayed: false };
  }

  async reverseCapture(
    entitlementId: EntityId,
    operationId: EntityId,
    actorUserId: EntityId,
    reason: string,
    now = new Date(),
  ) {
    const accountId = eventCoverAccountId(entitlementId);
    const account = this.requireAccount(accountId);
    const capture = this.entries.get(eventCoverEntryId(accountId, operationId, 'capture'));
    if (!capture) throw new NotFoundError('Event cover capture', operationId);
    const reversalId = eventCoverEntryId(accountId, operationId, 'reversal');
    const existing = this.entries.get(reversalId);
    if (existing) {
      if (
        existing.actorUserId !== actorUserId ||
        existing.reversesEntryId !== capture.id ||
        existing.reason !== reason.trim()
      ) {
        throw new ConflictError('Event cover reversal operation id is already used');
      }
      return { account, entry: existing, replayed: true };
    }
    const transition = reverseEventCoverCapture(account, capture, actorUserId, reason, now);
    this.accounts.set(accountId, transition.account);
    this.entries.set(transition.entry.id, transition.entry);
    return { ...transition, replayed: false };
  }

  private async resolve(
    accountId: EntityId,
    operationId: EntityId,
    action: 'capture' | 'void',
    now?: Date,
  ) {
    const account = this.requireAccount(accountId);
    const resultId = eventCoverEntryId(accountId, operationId, action);
    const existingResult = this.entries.get(resultId);
    if (existingResult) return { account, entry: existingResult, replayed: true };
    const reserve = this.entries.get(eventCoverEntryId(accountId, operationId, 'reserve'));
    if (!reserve) throw new NotFoundError('Event cover reservation', operationId);
    const priorEntries = [...this.entries.values()].filter(
      (entry) => entry.accountId === accountId,
    );
    const transition =
      action === 'capture'
        ? captureEventCoverReservation(account, reserve, priorEntries, now)
        : voidEventCoverReservation(account, reserve, priorEntries, now);
    this.accounts.set(accountId, transition.account);
    this.entries.set(transition.entry.id, transition.entry);
    return { ...transition, replayed: false };
  }

  private requireAccount(accountId: EntityId): EventCoverAccount {
    const account = this.accounts.get(accountId);
    if (!account) throw new NotFoundError('Event cover account', accountId);
    return account;
  }
}

function sameChallenge(
  left: EventCoverRedemptionChallenge,
  right: EventCoverRedemptionChallenge,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.entitlementId === right.entitlementId &&
    left.guestUserId === right.guestUserId &&
    left.amountPaise === right.amountPaise &&
    left.grossSpendPaise === right.grossSpendPaise &&
    left.receiptReference === right.receiptReference &&
    left.terminalId === right.terminalId &&
    left.initiatedByUserId === right.initiatedByUserId
  );
}

function sameIssuance(left: EventCoverAccount, right: EventCoverAccount): boolean {
  return (
    left.entitlementId === right.entitlementId &&
    left.orderId === right.orderId &&
    left.eventId === right.eventId &&
    left.guestUserId === right.guestUserId &&
    left.hostOrganizationId === right.hostOrganizationId &&
    left.venueOrganizationId === right.venueOrganizationId &&
    left.issuedPaise === right.issuedPaise &&
    left.refundPolicy === right.refundPolicy &&
    left.policyVersion === right.policyVersion
  );
}

function issuanceEntryMatches(entry: EventCoverEntry, account: EventCoverAccount): boolean {
  return (
    entry.type === 'issuance' &&
    entry.accountId === account.id &&
    entry.entitlementId === account.entitlementId &&
    entry.orderId === account.orderId &&
    entry.eventId === account.eventId &&
    entry.venueOrganizationId === account.venueOrganizationId &&
    entry.amountPaise === account.issuedPaise &&
    entry.policyVersion === account.policyVersion
  );
}

function refundEntryMatches(
  entry: EventCoverEntry,
  account: EventCoverAccount,
  input: { operationId: EntityId; actorUserId: EntityId; refundRequestId: EntityId },
): boolean {
  return (
    entry.type === 'refund' &&
    entry.accountId === account.id &&
    entry.entitlementId === account.entitlementId &&
    entry.orderId === account.orderId &&
    entry.eventId === account.eventId &&
    entry.operationId === input.operationId &&
    input.operationId === input.refundRequestId &&
    entry.actorUserId === input.actorUserId &&
    entry.amountPaise === account.issuedPaise &&
    entry.reversesEntryId === eventCoverEntryId(account.id, account.entitlementId, 'issuance') &&
    entry.policyVersion === account.policyVersion &&
    account.status === 'refunded' &&
    account.remainingPaise === 0 &&
    account.refundedPaise === account.issuedPaise
  );
}
