import { ConflictError, InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
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

import { outboxDocument } from './firestore-outbox-store.js';
import { paginateUnordered } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  EventCoverAccount,
  EventCoverEntry,
  EventCoverRedemptionChallenge,
} from '../../domain/models/event-cover.js';
import type {
  EventCoverAccountRepository,
  PaginationQuery,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore, Transaction } from 'firebase-admin/firestore';

const ACCOUNTS = 'v2_event_cover_accounts';
const ENTRIES = 'v2_event_cover_entries';
const CHALLENGES = 'v2_event_cover_redemption_challenges';

/** Firestore transactions keep balances and immutable cover facts in lockstep. */
export class FirestoreEventCoverAccountRepository implements EventCoverAccountRepository {
  constructor(private readonly db: Firestore) {}

  private get accounts() {
    return this.db.collection(ACCOUNTS);
  }

  private get entries() {
    return this.db.collection(ENTRIES);
  }

  private get challenges() {
    return this.db.collection(CHALLENGES);
  }

  async createIssuedAccount(account: EventCoverAccount): Promise<EventCoverAccount> {
    assertEventCoverAccountForIssuance(account);
    const accountRef = this.accounts.doc(account.id);
    const issuanceRef = this.entries.doc(
      eventCoverEntryId(account.id, account.entitlementId, 'issuance'),
    );
    return this.db.runTransaction(async (tx) => {
      const [accountSnapshot, issuanceSnapshot] = await Promise.all([
        tx.get(accountRef),
        tx.get(issuanceRef),
      ]);
      if (accountSnapshot.exists) {
        const current = toAccount(accountSnapshot.data() ?? {});
        const issuance = issuanceSnapshot.exists ? toEntry(issuanceSnapshot.data() ?? {}) : null;
        if (
          !issuance ||
          !sameIssuance(current, account) ||
          !issuanceEntryMatches(issuance, current)
        ) {
          throw new ConflictError(
            'Event cover account already exists with different issuance terms',
          );
        }
        return current;
      }
      if (issuanceSnapshot.exists) {
        throw new ConflictError('Event cover issuance exists without its account');
      }
      const entry = createIssuanceEntry(account);
      tx.create(accountRef, toAccountDocument(account));
      tx.create(issuanceRef, toEntryDocument(entry));
      enqueueCoverEvent(
        this.db,
        tx,
        'event-cover.issued',
        account,
        entry,
        'system:checkout-fulfillment',
      );
      return account;
    });
  }

  async getByEntitlement(entitlementId: EntityId): Promise<EventCoverAccount | null> {
    const snapshot = await this.accounts.doc(eventCoverAccountId(entitlementId)).get();
    return snapshot.exists ? toAccount(snapshot.data() ?? {}) : null;
  }

  async listByEvent(eventId: EntityId, query: PaginationQuery) {
    return paginateUnordered(this.accounts.where('eventId', '==', eventId), query, toAccount);
  }

  async transferHolder(
    entitlementId: EntityId,
    expectedCurrentHolderId: EntityId | null,
    nextHolderId: EntityId,
    now = new Date(),
  ) {
    const accountRef = this.accounts.doc(eventCoverAccountId(entitlementId));
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(accountRef);
      if (!snapshot.exists) return null;
      const account = toAccount(snapshot.data() ?? {});
      const transferred = transferEventCoverHolder(
        account,
        expectedCurrentHolderId,
        nextHolderId,
        now,
      );
      if (transferred !== account) tx.set(accountRef, toAccountDocument(transferred));
      return transferred;
    });
  }

  async listEntries(accountId: EntityId): Promise<EventCoverEntry[]> {
    const snapshot = await this.entries.where('accountId', '==', accountId).get();
    return snapshot.docs
      .map((document) => toEntry(document.data()))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createRedemptionChallenge(challenge: EventCoverRedemptionChallenge) {
    const challengeRef = this.challenges.doc(challenge.id);
    const accountRef = this.accounts.doc(challenge.accountId);
    const entitlementRef = this.db.collection('v2_entitlements').doc(challenge.entitlementId);
    return this.db.runTransaction(async (tx) => {
      const [challengeSnapshot, accountSnapshot, entitlementSnapshot] = await Promise.all([
        tx.get(challengeRef),
        tx.get(accountRef),
        tx.get(entitlementRef),
      ]);
      if (challengeSnapshot.exists) {
        const current = toChallenge(challengeSnapshot.data() ?? {});
        if (!sameChallenge(current, challenge)) {
          throw new ConflictError('Cover redemption challenge id is already used');
        }
        return current;
      }
      if (!accountSnapshot.exists)
        throw new NotFoundError('Event cover account', challenge.accountId);
      const entitlement = entitlementSnapshot.data();
      if (
        !entitlement ||
        (entitlement.currentHolderUserId ?? entitlement.userId) !== challenge.guestUserId ||
        entitlement.status !== 'valid' ||
        entitlement.pendingTransferId
      ) {
        throw new ConflictError(
          'Cover redemption is unavailable while ticket ownership is changing',
        );
      }
      const account = toAccount(accountSnapshot.data() ?? {});
      const reserveRef = this.entries.doc(
        eventCoverEntryId(challenge.accountId, challenge.id, 'reserve'),
      );
      const reserveSnapshot = await tx.get(reserveRef);
      if (reserveSnapshot.exists) {
        throw new ConflictError('Cover redemption reservation exists without its challenge');
      }
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
      tx.set(accountRef, toAccountDocument(reservation.account));
      tx.create(reserveRef, toEntryDocument(reservation.entry));
      tx.create(challengeRef, toChallengeDocument(challenge));
      enqueueCoverEvent(
        this.db,
        tx,
        'event-cover.reserved',
        reservation.account,
        reservation.entry,
        challenge.initiatedByUserId,
      );
      return challenge;
    });
  }

  async getRedemptionChallenge(challengeId: EntityId) {
    const snapshot = await this.challenges.doc(challengeId).get();
    return snapshot.exists ? toChallenge(snapshot.data() ?? {}) : null;
  }

  async expireRedemptionChallenge(challengeId: EntityId, now = new Date()) {
    const challengeRef = this.challenges.doc(challengeId);
    const initial = await challengeRef.get();
    if (!initial.exists) throw new NotFoundError('Cover redemption challenge', challengeId);
    const challengeBeforeTransaction = toChallenge(initial.data() ?? {});
    const accountRef = this.accounts.doc(challengeBeforeTransaction.accountId);
    const reserveRef = this.entries.doc(
      eventCoverEntryId(challengeBeforeTransaction.accountId, challengeId, 'reserve'),
    );
    const captureRef = this.entries.doc(
      eventCoverEntryId(challengeBeforeTransaction.accountId, challengeId, 'capture'),
    );
    const voidRef = this.entries.doc(
      eventCoverEntryId(challengeBeforeTransaction.accountId, challengeId, 'void'),
    );
    return this.db.runTransaction(async (tx) => {
      const [challengeSnapshot, accountSnapshot, reserveSnapshot, captureSnapshot, voidSnapshot] =
        await Promise.all([
          tx.get(challengeRef),
          tx.get(accountRef),
          tx.get(reserveRef),
          tx.get(captureRef),
          tx.get(voidRef),
        ]);
      if (!challengeSnapshot.exists)
        throw new NotFoundError('Cover redemption challenge', challengeId);
      const challenge = toChallenge(challengeSnapshot.data() ?? {});
      if (challenge.status === 'expired') return challenge;
      const expired = expireEventCoverRedemptionChallenge(challenge, now);
      const account = requireAccount(accountSnapshot.data(), challenge.accountId);
      const reserve = reserveSnapshot.exists ? toEntry(reserveSnapshot.data() ?? {}) : null;
      if (!reserve || captureSnapshot.exists || voidSnapshot.exists) {
        throw new InvalidOperationError('Expired cover request has no pending reservation');
      }
      const voided = voidEventCoverReservation(account, reserve, [reserve], now);
      tx.set(accountRef, toAccountDocument(voided.account));
      tx.create(voidRef, toEntryDocument(voided.entry));
      tx.set(challengeRef, toChallengeDocument(expired));
      enqueueCoverEvent(
        this.db,
        tx,
        'event-cover.voided',
        voided.account,
        voided.entry,
        'system:event-cover-expiry',
      );
      return expired;
    });
  }

  async cleanupExpiredRedemptionChallenges(now: Date, limit = 100): Promise<number> {
    const snapshot = await this.challenges
      .where('status', 'in', ['pending', 'confirmed'])
      .where('expiresAt', '<=', now.toISOString())
      .limit(Math.max(1, Math.min(500, limit)))
      .get();
    let expiredCount = 0;
    for (const document of snapshot.docs) {
      try {
        const expired = await this.expireRedemptionChallenge(document.id, now);
        if (expired.status === 'expired') expiredCount += 1;
      } catch (error) {
        const current = await this.getRedemptionChallenge(document.id);
        if (current?.status !== 'consumed' && current?.status !== 'expired') throw error;
      }
    }
    return expiredCount;
  }

  async confirmRedemptionChallenge(challengeId: EntityId, guestUserId: EntityId, now = new Date()) {
    const challengeRef = this.challenges.doc(challengeId);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(challengeRef);
      if (!snapshot.exists) throw new NotFoundError('Cover redemption challenge', challengeId);
      const current = toChallenge(snapshot.data() ?? {});
      if (current.status === 'confirmed' && current.guestUserId === guestUserId) return current;
      const confirmed = confirmEventCoverRedemptionChallenge(current, guestUserId, now);
      tx.set(challengeRef, toChallengeDocument(confirmed));
      return confirmed;
    });
  }

  async consumeConfirmedRedemption(challengeId: EntityId, venueUserId: EntityId, now = new Date()) {
    const challengeRef = this.challenges.doc(challengeId);
    const challengeSnapshot = await challengeRef.get();
    if (!challengeSnapshot.exists)
      throw new NotFoundError('Cover redemption challenge', challengeId);
    const firstRead = toChallenge(challengeSnapshot.data() ?? {});
    const accountRef = this.accounts.doc(firstRead.accountId);
    const reserveRef = this.entries.doc(
      eventCoverEntryId(firstRead.accountId, challengeId, 'reserve'),
    );
    const captureRef = this.entries.doc(
      eventCoverEntryId(firstRead.accountId, challengeId, 'capture'),
    );
    return this.db.runTransaction(async (tx) => {
      const [challengeSnap, accountSnap, reserveSnap, captureSnap] = await Promise.all([
        tx.get(challengeRef),
        tx.get(accountRef),
        tx.get(reserveRef),
        tx.get(captureRef),
      ]);
      if (!challengeSnap.exists) throw new NotFoundError('Cover redemption challenge', challengeId);
      const challenge = toChallenge(challengeSnap.data() ?? {});
      const account = requireAccount(accountSnap.data(), challenge.accountId);
      if (challenge.status === 'consumed' && captureSnap.exists) {
        return { account, entry: toEntry(captureSnap.data() ?? {}) };
      }
      if (
        challenge.status !== 'confirmed' ||
        challenge.initiatedByUserId !== venueUserId ||
        Date.parse(challenge.expiresAt) <= now.getTime() ||
        !reserveSnap.exists ||
        captureSnap.exists
      ) {
        throw new InvalidOperationError('Cover redemption is not confirmed or has expired');
      }
      const reservation = toEntry(reserveSnap.data() ?? {});
      const captured = captureEventCoverReservation(account, reservation, [reservation], now);
      const consumed = consumeEventCoverRedemptionChallenge(challenge, now);
      tx.set(accountRef, toAccountDocument(captured.account));
      tx.create(captureRef, toEntryDocument(captured.entry));
      tx.set(challengeRef, toChallengeDocument(consumed));
      enqueueCoverEvent(
        this.db,
        tx,
        'event-cover.redeemed',
        captured.account,
        captured.entry,
        venueUserId,
      );
      return captured;
    });
  }

  async reverseCapture(
    entitlementId: EntityId,
    operationId: EntityId,
    actorUserId: EntityId,
    reason: string,
    now = new Date(),
  ) {
    const accountId = eventCoverAccountId(entitlementId);
    const accountRef = this.accounts.doc(accountId);
    const captureRef = this.entries.doc(eventCoverEntryId(accountId, operationId, 'capture'));
    const reversalRef = this.entries.doc(eventCoverEntryId(accountId, operationId, 'reversal'));
    return this.db.runTransaction(async (tx) => {
      const [accountSnapshot, captureSnapshot, reversalSnapshot] = await Promise.all([
        tx.get(accountRef),
        tx.get(captureRef),
        tx.get(reversalRef),
      ]);
      const account = requireAccount(accountSnapshot.data(), accountId);
      if (!captureSnapshot.exists) throw new NotFoundError('Event cover capture', operationId);
      const capture = toEntry(captureSnapshot.data() ?? {});
      if (reversalSnapshot.exists) {
        const existing = toEntry(reversalSnapshot.data() ?? {});
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
      tx.set(accountRef, toAccountDocument(transition.account));
      tx.create(reversalRef, toEntryDocument(transition.entry));
      enqueueCoverEvent(
        this.db,
        tx,
        'event-cover.reversed',
        transition.account,
        transition.entry,
        actorUserId,
      );
      return { ...transition, replayed: false };
    });
  }

  async reserve(accountId: EntityId, input: Parameters<EventCoverAccountRepository['reserve']>[1]) {
    const accountRef = this.accounts.doc(accountId);
    const reserveRef = this.entries.doc(eventCoverEntryId(accountId, input.operationId, 'reserve'));
    const captureRef = this.entries.doc(eventCoverEntryId(accountId, input.operationId, 'capture'));
    const voidRef = this.entries.doc(eventCoverEntryId(accountId, input.operationId, 'void'));
    return this.db.runTransaction(async (tx) => {
      const [accountSnapshot, reserveSnapshot, captureSnapshot, voidSnapshot] = await Promise.all([
        tx.get(accountRef),
        tx.get(reserveRef),
        tx.get(captureRef),
        tx.get(voidRef),
      ]);
      const account = requireAccount(accountSnapshot.data(), accountId);
      if (reserveSnapshot.exists) {
        const existing = toEntry(reserveSnapshot.data() ?? {});
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
      if (captureSnapshot.exists || voidSnapshot.exists) {
        throw new ConflictError('Event cover operation is already resolved');
      }
      const transition = reserveEventCover(account, input);
      tx.set(accountRef, toAccountDocument(transition.account));
      tx.create(reserveRef, toEntryDocument(transition.entry));
      enqueueCoverEvent(
        this.db,
        tx,
        'event-cover.reserved',
        transition.account,
        transition.entry,
        input.actorUserId,
      );
      return { ...transition, replayed: false };
    });
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
    const uniqueIds = [...new Set(entitlementIds)];
    if (uniqueIds.length !== entitlementIds.length) {
      throw new ConflictError('Refund contains duplicate cover entitlements');
    }
    const refs = uniqueIds.map((id) => this.accounts.doc(eventCoverAccountId(id)));
    return this.db.runTransaction(async (tx) => {
      const snapshots = await Promise.all(refs.map((ref) => tx.get(ref)));
      const accounts = snapshots.flatMap((snapshot) =>
        snapshot.exists ? [toAccount(snapshot.data() ?? {})] : [],
      );
      const frozen = accounts.map((account) =>
        freezeUnusedEventCoverForRefund(account, refundRequestId, now),
      );
      for (const account of frozen) {
        tx.set(this.accounts.doc(account.id), toAccountDocument(account));
      }
      return frozen;
    });
  }

  async releaseRefundFreeze(
    entitlementIds: readonly EntityId[],
    refundRequestId: EntityId,
    now = new Date(),
  ) {
    const uniqueIds = [...new Set(entitlementIds)];
    if (uniqueIds.length !== entitlementIds.length) {
      throw new ConflictError('Refund contains duplicate cover entitlements');
    }
    const refs = uniqueIds.map((id) => this.accounts.doc(eventCoverAccountId(id)));
    await this.db.runTransaction(async (tx) => {
      const snapshots = await Promise.all(refs.map((ref) => tx.get(ref)));
      const transitions: EventCoverAccount[] = [];
      for (const snapshot of snapshots) {
        if (!snapshot.exists) continue;
        const account = toAccount(snapshot.data() ?? {});
        if (account.status === 'active' && account.refundRequestId == null) continue;
        transitions.push(releaseUnusedEventCoverRefundFreeze(account, refundRequestId, now));
      }
      for (const account of transitions) {
        tx.set(this.accounts.doc(account.id), toAccountDocument(account));
      }
    });
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
    const accountRef = this.accounts.doc(accountId);
    const refundRef = this.entries.doc(eventCoverEntryId(accountId, input.operationId, 'refund'));
    return this.db.runTransaction(async (tx) => {
      const accountSnapshot = await tx.get(accountRef);
      const account = requireAccount(accountSnapshot.data(), accountId);
      const issuanceRef = this.entries.doc(
        eventCoverEntryId(accountId, account.entitlementId, 'issuance'),
      );
      const [issuanceSnapshot, refundSnapshot] = await Promise.all([
        tx.get(issuanceRef),
        tx.get(refundRef),
      ]);
      if (refundSnapshot.exists) {
        const entry = toEntry(refundSnapshot.data() ?? {});
        if (!refundEntryMatches(entry, account, input)) {
          throw new ConflictError('Event cover refund operation id is already used');
        }
        return { account, entry, replayed: true };
      }
      const issuance = issuanceSnapshot.exists ? toEntry(issuanceSnapshot.data() ?? {}) : null;
      if (!issuance || issuance.type !== 'issuance') {
        throw new InvalidOperationError('Event cover issuance fact is unavailable');
      }
      const transition = refundUnusedEventCover(account, input);
      tx.set(accountRef, toAccountDocument(transition.account));
      tx.create(refundRef, toEntryDocument(transition.entry));
      enqueueCoverEvent(
        this.db,
        tx,
        'event-cover.refunded',
        transition.account,
        transition.entry,
        input.actorUserId,
      );
      return { ...transition, replayed: false };
    });
  }

  private async resolve(
    accountId: EntityId,
    operationId: EntityId,
    action: 'capture' | 'void',
    now?: Date,
  ) {
    const accountRef = this.accounts.doc(accountId);
    const reserveRef = this.entries.doc(eventCoverEntryId(accountId, operationId, 'reserve'));
    const captureRef = this.entries.doc(eventCoverEntryId(accountId, operationId, 'capture'));
    const voidRef = this.entries.doc(eventCoverEntryId(accountId, operationId, 'void'));
    return this.db.runTransaction(async (tx) => {
      const [accountSnapshot, reserveSnapshot, captureSnapshot, voidSnapshot] = await Promise.all([
        tx.get(accountRef),
        tx.get(reserveRef),
        tx.get(captureRef),
        tx.get(voidRef),
      ]);
      const account = requireAccount(accountSnapshot.data(), accountId);
      const resultSnapshot = action === 'capture' ? captureSnapshot : voidSnapshot;
      if (resultSnapshot.exists) {
        return { account, entry: toEntry(resultSnapshot.data() ?? {}), replayed: true };
      }
      const reserve = reserveSnapshot.exists ? toEntry(reserveSnapshot.data() ?? {}) : null;
      if (!reserve) throw new NotFoundError('Event cover reservation', operationId);
      const priorEntries = [
        reserve,
        ...(captureSnapshot.exists ? [toEntry(captureSnapshot.data() ?? {})] : []),
        ...(voidSnapshot.exists ? [toEntry(voidSnapshot.data() ?? {})] : []),
      ];
      const transition =
        action === 'capture'
          ? captureEventCoverReservation(account, reserve, priorEntries, now)
          : voidEventCoverReservation(account, reserve, priorEntries, now);
      const resultRef = action === 'capture' ? captureRef : voidRef;
      tx.set(accountRef, toAccountDocument(transition.account));
      tx.create(resultRef, toEntryDocument(transition.entry));
      enqueueCoverEvent(
        this.db,
        tx,
        action === 'capture' ? 'event-cover.redeemed' : 'event-cover.voided',
        transition.account,
        transition.entry,
        transition.entry.actorUserId ?? 'system:event-cover',
      );
      return { ...transition, replayed: false };
    });
  }
}

function enqueueCoverEvent(
  db: Firestore,
  transaction: Transaction,
  type:
    | 'event-cover.issued'
    | 'event-cover.reserved'
    | 'event-cover.redeemed'
    | 'event-cover.reversed'
    | 'event-cover.voided'
    | 'event-cover.refunded',
  account: EventCoverAccount,
  entry: EventCoverEntry,
  actorId: EntityId,
): void {
  const occurredAt = Date.parse(entry.createdAt);
  const common = {
    aggregateId: account.id,
    organizationId: account.hostOrganizationId,
    actorId,
    occurredAt,
  };
  let event;
  switch (type) {
    case 'event-cover.issued':
      event = domainEvent({
        ...common,
        id: deterministicDomainEventId(type, account.id),
        type,
        payload: {
          accountId: account.id,
          entitlementId: account.entitlementId,
          orderId: account.orderId,
          eventId: account.eventId,
          venueOrganizationId: account.venueOrganizationId,
          amountPaise: entry.amountPaise,
          policyVersion: account.policyVersion,
        },
      });
      break;
    case 'event-cover.reserved':
    case 'event-cover.redeemed':
    case 'event-cover.reversed':
    case 'event-cover.voided':
      event = domainEvent({
        ...common,
        id: deterministicDomainEventId(type, account.id, entry.operationId),
        type,
        payload: {
          accountId: account.id,
          entitlementId: account.entitlementId,
          eventId: account.eventId,
          operationId: entry.operationId,
          venueOrganizationId: account.venueOrganizationId,
          amountPaise: entry.amountPaise,
        },
      });
      break;
    case 'event-cover.refunded':
      event = domainEvent({
        ...common,
        id: deterministicDomainEventId(type, account.id, entry.operationId),
        type,
        payload: {
          accountId: account.id,
          entitlementId: account.entitlementId,
          orderId: account.orderId,
          eventId: account.eventId,
          operationId: entry.operationId,
          venueOrganizationId: account.venueOrganizationId,
          amountPaise: entry.amountPaise,
          policyVersion: account.policyVersion,
        },
      });
      break;
  }
  transaction.create(db.collection('v2_outbox').doc(event.id), outboxDocument(event));
}

function createIssuanceEntry(account: EventCoverAccount): EventCoverEntry {
  return {
    ...newVersionedEntity(new Date(account.createdAt)),
    id: eventCoverEntryId(account.id, account.entitlementId, 'issuance'),
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
}

function requireAccount(data: DocumentData | undefined, id: EntityId): EventCoverAccount {
  if (!data) throw new NotFoundError('Event cover account', id);
  return toAccount(data);
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

function toAccountDocument(account: EventCoverAccount): DocumentData {
  return { ...account };
}

function toEntryDocument(entry: EventCoverEntry): DocumentData {
  return { ...entry };
}

function toAccount(data: DocumentData): EventCoverAccount {
  return {
    ...data,
    // Legacy M5 accounts have no frozen refund rule; require manual review.
    refundPolicy:
      data.refundPolicy === 'unused_full_before_redemption'
        ? 'unused_full_before_redemption'
        : 'saved_policy_review',
    refundRequestId: typeof data.refundRequestId === 'string' ? data.refundRequestId : null,
  } as EventCoverAccount;
}

function toEntry(data: DocumentData): EventCoverEntry {
  return data as EventCoverEntry;
}

function toChallengeDocument(challenge: EventCoverRedemptionChallenge): DocumentData {
  return { ...challenge };
}

function toChallenge(data: DocumentData): EventCoverRedemptionChallenge {
  return data as EventCoverRedemptionChallenge;
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
