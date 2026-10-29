import { ConflictError, NotFoundError, VersionConflictError } from '../../domain/errors.js';
import { bumpVersion } from '../../domain/identity.js';
import {
  admitSeats,
  changeEntitlementHolder,
  currentEntitlementHolderId,
  redeemTicketAddonEntitlement,
  restoreEntitlementAfterUpgradeRefund,
  supersedeEntitlementForUpgrade,
} from '../../domain/models/entitlement.js';
import { eventCoverAccountId, transferEventCoverHolder } from '../../domain/models/event-cover.js';
import { resolveTicketTransfer } from '../../domain/models/ticket-transfer.js';

import { compareAndSet } from './compare-and-set.js';
import { outboxDocument } from './firestore-outbox-store.js';
import { paginateQuery, paginateUnordered } from './pagination.js';

import type { DomainEvent } from '../../domain/events.js';
import type { EntityId } from '../../domain/identity.js';
import type { Entitlement, EntitlementStatus } from '../../domain/models/entitlement.js';
import type { TicketTransfer, TicketTransferStatus } from '../../domain/models/ticket-transfer.js';
import type {
  AdmissionClaim,
  ClaimAdmissionOptions,
  EntitlementRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const COLLECTION = 'v2_entitlements';
const TRANSFER_COLLECTION = 'v2_ticket_transfers';

/**
 * Firestore adapter for `EntitlementRepository` (Phase 4).
 * Same interface as `MemoryEntitlementRepository`.
 * `orderId` index is denormalized for fulfilment verification.
 */
export class FirestoreEntitlementRepository implements EntitlementRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(COLLECTION);
  }

  private get transferCollection() {
    return this.db.collection(TRANSFER_COLLECTION);
  }

  async getById(entitlementId: EntityId): Promise<Entitlement | null> {
    const snap = await this.collection.doc(entitlementId).get();
    const data = snap.data();
    return data ? toEntitlement(data) : null;
  }

  async findById(entitlementId: EntityId): Promise<Entitlement | null> {
    return this.getById(entitlementId);
  }

  async getByOrderId(orderId: EntityId): Promise<Entitlement[]> {
    const snap = await this.collection.where('orderId', '==', orderId).get();
    return snap.docs.map((doc) => toEntitlement(doc.data()));
  }

  // Index-free (single-field filter; newest-first sort happens in code —
  // see `paginateUnordered`): these reads must work with zero provisioned
  // composite indexes (wallet, door, partner surfaces).
  async listByUser(userId: EntityId, query: PaginationQuery): Promise<Page<Entitlement>> {
    const base = this.collection.where('userId', '==', userId);
    return paginateUnordered(base, query, toEntitlement);
  }

  async listByHolder(userId: EntityId, query: PaginationQuery): Promise<Page<Entitlement>> {
    const [purchased, assigned] = await Promise.all([
      this.collection.where('userId', '==', userId).get(),
      this.collection.where('currentHolderUserId', '==', userId).get(),
    ]);
    const merged = new Map<string, Entitlement>();
    for (const doc of [...purchased.docs, ...assigned.docs]) {
      const entitlement = toEntitlement(doc.data());
      if ((entitlement.currentHolderUserId ?? entitlement.userId) === userId) {
        merged.set(entitlement.id, entitlement);
      }
    }
    return paginateMemory([...merged.values()], query);
  }

  async listByEvent(eventId: EntityId, query: PaginationQuery): Promise<Page<Entitlement>> {
    const base = this.collection.where('eventId', '==', eventId);
    return paginateUnordered(base, query, toEntitlement);
  }

  async listByOrganization(
    organizationId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<Entitlement>> {
    const base = this.collection.where('organizationId', '==', organizationId);
    return paginateUnordered(base, query, toEntitlement);
  }

  async listAll(query: PaginationQuery): Promise<Page<Entitlement>> {
    const base = this.collection.orderBy('createdAt', 'desc');
    return paginateQuery(base, query, toEntitlement);
  }

  async save(
    entitlement: Entitlement,
    _tx?: TxContext | null,
    outboxEvent?: DomainEvent,
  ): Promise<void> {
    if (!outboxEvent) {
      await compareAndSet(this.db, this.collection, entitlement, toDoc);
      return;
    }
    const entitlementRef = this.collection.doc(entitlement.id);
    const outboxRef = this.db.collection('v2_outbox').doc(outboxEvent.id);
    await this.db.runTransaction(async (tx) => {
      const [entitlementSnap, outboxSnap] = await Promise.all([
        tx.get(entitlementRef),
        tx.get(outboxRef),
      ]);
      if (entitlement.version > 1) {
        const storedVersion = Number(entitlementSnap.data()?.version ?? 0);
        if (!entitlementSnap.exists || storedVersion !== entitlement.version - 1) {
          throw new VersionConflictError(entitlement.version - 1, storedVersion);
        }
      }
      tx.set(entitlementRef, toDoc(entitlement));
      if (!outboxSnap.exists) tx.create(outboxRef, outboxDocument(outboxEvent));
    });
  }

  async saveMany(entitlements: Entitlement[], _tx?: TxContext | null): Promise<void> {
    const batch = this.db.batch();
    for (const e of entitlements) {
      const ref = this.collection.doc(e.id);
      // For creates (version 1), just set; for updates, use compare-and-set in transaction
      if (e.version <= 1) {
        batch.set(ref, toDoc(e));
      } else {
        // For version > 1, we need a transaction with compare-and-set
        // This is a simplified approach - in production you'd want a proper transaction
        await compareAndSet(this.db, this.collection, e, toDoc);
      }
    }
    await batch.commit();
  }

  async redeemTicketAddon(
    input: {
      entitlementId: EntityId;
      addonEntitlementId: EntityId;
      eventId: EntityId;
      now?: Date;
    },
    outboxEvent?: DomainEvent,
  ): Promise<Entitlement> {
    const ref = this.collection.doc(input.entitlementId);
    return this.db.runTransaction(async (tx) => {
      const outboxRef = outboxEvent ? this.db.collection('v2_outbox').doc(outboxEvent.id) : null;
      const snapshot = await tx.get(ref);
      const outboxSnapshot = outboxRef ? await tx.get(outboxRef) : null;
      const data = snapshot.data();
      const current = data ? toEntitlement(data) : null;
      if (!current || current.eventId !== input.eventId) {
        throw new NotFoundError('Ticket extra', input.addonEntitlementId);
      }
      const updated = redeemTicketAddonEntitlement(current, input.addonEntitlementId, input.now);
      tx.set(ref, toDoc(updated));
      if (outboxRef && outboxSnapshot && !outboxSnapshot.exists && outboxEvent) {
        tx.create(outboxRef, outboxDocument(outboxEvent));
      }
      return updated;
    });
  }

  async replaceForUpgrade(input: {
    sourceEntitlementId: EntityId;
    expectedSourceVersion: number;
    replacement: Entitlement;
    now?: Date;
  }): Promise<{ source: Entitlement; replacement: Entitlement }> {
    const sourceRef = this.collection.doc(input.sourceEntitlementId);
    const replacementRef = this.collection.doc(input.replacement.id);
    return this.db.runTransaction(async (tx) => {
      const [sourceSnap, replacementSnap] = await Promise.all([
        tx.get(sourceRef),
        tx.get(replacementRef),
      ]);
      const sourceData = sourceSnap.data();
      const replacementData = replacementSnap.data();
      const source = sourceData ? toEntitlement(sourceData) : null;
      const replacement = replacementData ? toEntitlement(replacementData) : null;
      if (
        source?.status === 'void' &&
        source.upgradedToEntitlementId === input.replacement.id &&
        replacement
      ) {
        return { source, replacement };
      }
      if (!source) throw new NotFoundError('Ticket', input.sourceEntitlementId);
      if (source.version !== input.expectedSourceVersion) {
        throw new VersionConflictError(input.expectedSourceVersion, source.version);
      }
      if (replacement) throw new ConflictError('The replacement ticket already exists');
      if (
        input.replacement.status !== 'valid' ||
        (input.replacement.unitKind ?? 'paid') !== 'paid' ||
        input.replacement.upgradeFromEntitlementId !== source.id ||
        input.replacement.eventId !== source.eventId ||
        input.replacement.userId !== source.userId ||
        currentEntitlementHolderId(input.replacement) !== currentEntitlementHolderId(source) ||
        input.replacement.tierId === source.tierId ||
        input.replacement.scanCount !== 0 ||
        input.replacement.refundLock ||
        input.replacement.pendingTransferId
      ) {
        throw new ConflictError('The replacement ticket does not match the source ticket');
      }
      const retired = supersedeEntitlementForUpgrade(source, input.replacement.id, input.now);
      tx.set(sourceRef, toDoc(retired));
      tx.create(replacementRef, toDoc(input.replacement));
      return { source: retired, replacement: input.replacement };
    });
  }

  async restoreForUpgradeRefund(input: {
    sourceEntitlementId: EntityId;
    replacementEntitlementId: EntityId;
    refundRequestId: EntityId;
    now?: Date;
  }): Promise<{ source: Entitlement; replacement: Entitlement }> {
    const sourceRef = this.collection.doc(input.sourceEntitlementId);
    const replacementRef = this.collection.doc(input.replacementEntitlementId);
    return this.db.runTransaction(async (tx) => {
      const [sourceSnap, replacementSnap] = await Promise.all([
        tx.get(sourceRef),
        tx.get(replacementRef),
      ]);
      const sourceData = sourceSnap.data();
      const replacementData = replacementSnap.data();
      const source = sourceData ? toEntitlement(sourceData) : null;
      const replacement = replacementData ? toEntitlement(replacementData) : null;
      if (!source) throw new NotFoundError('Ticket', input.sourceEntitlementId);
      if (!replacement) throw new NotFoundError('Ticket', input.replacementEntitlementId);
      const restored = restoreEntitlementAfterUpgradeRefund({
        source,
        replacement,
        refundRequestId: input.refundRequestId,
        now: input.now,
      });
      tx.set(sourceRef, toDoc(restored.source));
      tx.set(replacementRef, toDoc(restored.replacement));
      return restored;
    });
  }

  /**
   * One transaction: read, evaluate with the domain rule, write the
   * incremented entitlement. Firestore aborts and retries the whole closure
   * if the document changed under it, so the second of two simultaneous
   * scanners re-reads the incremented `scanCount` and is denied
   * `already_used` — a double admission is impossible, not merely unlikely.
   */
  async claimAdmission(
    entitlementId: EntityId,
    eventId: EntityId,
    options?: ClaimAdmissionOptions,
  ): Promise<AdmissionClaim> {
    const ref = this.collection.doc(entitlementId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      const current = data ? toEntitlement(data) : null;
      const decision = admitSeats(current, eventId, options);
      if (decision.admitted && decision.entitlement) tx.set(ref, toDoc(decision.entitlement));
      return decision;
    });
  }

  async countValidByTier(tierId: EntityId): Promise<number> {
    const snap = await this.collection
      .where('tierId', '==', tierId)
      .where('status', '==', 'valid')
      .count()
      .get();
    return snap.data().count;
  }

  async countActivePaidUnitsByUserAndEvent(userId: EntityId, eventId: EntityId): Promise<number> {
    const snap = await this.collection
      .where('userId', '==', userId)
      .where('eventId', '==', eventId)
      .get();
    return snap.docs.reduce((count, doc) => {
      const entitlement = toEntitlement(doc.data());
      return entitlement.status !== 'void' && entitlement.unitKind === 'paid'
        ? count + entitlement.scanCountAllowed
        : count;
    }, 0);
  }

  async createTicketTransfer(
    transfer: TicketTransfer,
    expectedCustodianUserId: EntityId,
    outboxEvent?: DomainEvent,
  ): Promise<TicketTransfer> {
    const entitlementRef = this.collection.doc(transfer.entitlementId);
    const transferRef = this.transferCollection.doc(transfer.id);
    const coverRef = this.db
      .collection('v2_event_cover_accounts')
      .doc(eventCoverAccountId(transfer.entitlementId));
    const outboxRef = outboxEvent ? this.db.collection('v2_outbox').doc(outboxEvent.id) : null;
    return this.db.runTransaction(async (tx) => {
      const [entitlementSnap, transferSnap, outboxSnap, coverSnap] = await Promise.all([
        tx.get(entitlementRef),
        tx.get(transferRef),
        outboxRef ? tx.get(outboxRef) : Promise.resolve(null),
        tx.get(coverRef),
      ]);
      if (transferSnap.exists) throw new ConflictError('Transfer already exists');
      const data = entitlementSnap.data();
      if (!data) throw new NotFoundError('Ticket', transfer.entitlementId);
      const entitlement = toEntitlement(data);
      const currentHolder = currentEntitlementHolderId(entitlement);
      const purchaserCustody =
        currentHolder === null && entitlement.userId === expectedCustodianUserId;
      if (
        (currentHolder !== expectedCustodianUserId && !purchaserCustody) ||
        transfer.senderUserId !== expectedCustodianUserId
      ) {
        throw new NotFoundError('Ticket', transfer.entitlementId);
      }
      if (
        entitlement.status !== 'valid' ||
        entitlement.scanCount > 0 ||
        entitlement.refundLock ||
        entitlement.pendingTransferId
      ) {
        throw new ConflictError('This ticket cannot be transferred now');
      }
      if (coverSnap.exists) {
        const cover = coverSnap.data() ?? {};
        if (cover.status !== 'active' || Number(cover.reservedPaise ?? 0) > 0) {
          throw new ConflictError(
            'This ticket cannot be transferred while event cover is reserved or frozen',
          );
        }
      }
      tx.create(transferRef, toTransferDoc(transfer));
      tx.set(
        entitlementRef,
        toDoc({
          ...bumpVersion(entitlement, new Date(transfer.createdAt)),
          pendingTransferId: transfer.id,
        }),
      );
      if (outboxRef && outboxEvent && !outboxSnap?.exists) {
        tx.create(outboxRef, outboxDocument(outboxEvent));
      }
      return transfer;
    });
  }

  async resolveTicketTransfer(input: {
    transferId: EntityId;
    actorUserId: EntityId;
    recipientEmailHash?: string;
    action: 'accept' | 'decline' | 'cancel' | 'freeze' | 'expire';
    holderName?: string;
    now?: Date;
    outboxEvent?: DomainEvent;
  }): Promise<{ transfer: TicketTransfer; entitlement: Entitlement }> {
    const transferRef = this.transferCollection.doc(input.transferId);
    return this.db.runTransaction(async (tx) => {
      const transferSnap = await tx.get(transferRef);
      const transferData = transferSnap.data();
      if (!transferData) throw new NotFoundError('Ticket transfer', input.transferId);
      const transfer = toTicketTransfer(transferData);
      const entitlementRef = this.collection.doc(transfer.entitlementId);
      const entitlementSnap = await tx.get(entitlementRef);
      const entitlementData = entitlementSnap.data();
      if (!entitlementData) throw new NotFoundError('Ticket', transfer.entitlementId);
      const entitlement = toEntitlement(entitlementData);
      if (entitlement.pendingTransferId !== transfer.id) {
        throw new ConflictError('This ticket transfer is no longer pending');
      }
      if (input.action === 'cancel' && input.actorUserId !== transfer.senderUserId) {
        throw new NotFoundError('Ticket transfer', input.transferId);
      }
      if (
        input.action !== 'expire' &&
        input.action !== 'freeze' &&
        input.action !== 'cancel' &&
        input.actorUserId !== transfer.recipientUserId &&
        (!transfer.recipientEmailHash || input.recipientEmailHash !== transfer.recipientEmailHash)
      ) {
        throw new NotFoundError('Ticket transfer', input.transferId);
      }
      const now = input.now ?? new Date();
      const isExpired = Date.parse(transfer.expiresAt) <= now.getTime();
      if (input.action === 'expire' && !isExpired) {
        throw new ConflictError('This ticket transfer has not expired');
      }
      const status: TicketTransferStatus = isExpired
        ? 'expired'
        : input.action === 'accept'
          ? 'accepted'
          : input.action === 'decline'
            ? 'declined'
            : input.action === 'freeze'
              ? 'frozen'
              : 'cancelled';
      const nextTransfer = resolveTicketTransfer(transfer, status, now);
      const nextEntitlement =
        status === 'accepted'
          ? {
              ...changeEntitlementHolder(entitlement, {
                expectedCurrentHolderUserId: currentEntitlementHolderId(entitlement),
                nextHolderUserId: input.actorUserId,
                holderName: input.holderName ?? '',
                now,
              }),
              pendingTransferId: null,
            }
          : {
              ...bumpVersion(entitlement, now),
              // A support freeze blocks further invitations until a separate
              // reviewed recovery action releases the lock.
              pendingTransferId: status === 'frozen' ? transfer.id : null,
            };
      const coverRef = this.db
        .collection('v2_event_cover_accounts')
        .doc(eventCoverAccountId(transfer.entitlementId));
      const coverSnap = status === 'accepted' ? await tx.get(coverRef) : null;
      const coverAccount = coverSnap?.exists ? coverSnap.data() : null;
      const nextCoverAccount = coverAccount
        ? transferEventCoverHolder(
            coverAccount as Parameters<typeof transferEventCoverHolder>[0],
            currentEntitlementHolderId(entitlement),
            input.actorUserId,
            now,
          )
        : null;
      const outboxRef = input.outboxEvent
        ? this.db.collection('v2_outbox').doc(input.outboxEvent.id)
        : null;
      const outboxSnap = outboxRef ? await tx.get(outboxRef) : null;
      tx.set(transferRef, toTransferDoc(nextTransfer));
      tx.set(entitlementRef, toDoc(nextEntitlement));
      if (nextCoverAccount) tx.set(coverRef, { ...nextCoverAccount });
      if (outboxRef && input.outboxEvent && !outboxSnap?.exists) {
        tx.create(outboxRef, outboxDocument(input.outboxEvent));
      }
      return { transfer: nextTransfer, entitlement: nextEntitlement };
    });
  }

  async getTicketTransfer(transferId: EntityId): Promise<TicketTransfer | null> {
    const snap = await this.transferCollection.doc(transferId).get();
    const data = snap.data();
    return data ? toTicketTransfer(data) : null;
  }

  async releaseFrozenTicketTransfer(input: {
    transferId: EntityId;
    now?: Date;
    outboxEvent?: DomainEvent;
  }): Promise<{ transfer: TicketTransfer; entitlement: Entitlement }> {
    const transferRef = this.transferCollection.doc(input.transferId);
    return this.db.runTransaction(async (tx) => {
      const transferSnap = await tx.get(transferRef);
      const transferData = transferSnap.data();
      if (!transferData) throw new NotFoundError('Ticket transfer', input.transferId);
      const transfer = toTicketTransfer(transferData);
      if (transfer.status !== 'frozen') {
        throw new ConflictError('Only a frozen ticket transfer can be released');
      }
      const entitlementRef = this.collection.doc(transfer.entitlementId);
      const entitlementSnap = await tx.get(entitlementRef);
      const entitlementData = entitlementSnap.data();
      if (!entitlementData) throw new NotFoundError('Ticket', transfer.entitlementId);
      const entitlement = toEntitlement(entitlementData);
      if (
        entitlement.pendingTransferId !== transfer.id ||
        entitlement.status !== 'valid' ||
        entitlement.scanCount > 0 ||
        entitlement.refundLock
      ) {
        throw new ConflictError('The frozen ticket can no longer be released');
      }
      const now = input.now ?? new Date();
      const released = { ...bumpVersion(entitlement, now), pendingTransferId: null };
      const outboxRef = input.outboxEvent
        ? this.db.collection('v2_outbox').doc(input.outboxEvent.id)
        : null;
      const outboxSnap = outboxRef ? await tx.get(outboxRef) : null;
      tx.set(entitlementRef, toDoc(released));
      if (outboxRef && input.outboxEvent && !outboxSnap?.exists) {
        tx.create(outboxRef, outboxDocument(input.outboxEvent));
      }
      return { transfer, entitlement: released };
    });
  }

  async listTicketTransfersByEntitlement(entitlementId: EntityId): Promise<TicketTransfer[]> {
    const snap = await this.transferCollection.where('entitlementId', '==', entitlementId).get();
    return snap.docs.map((doc) => toTicketTransfer(doc.data()));
  }

  async listExpiredTicketTransfers(now: Date, limit = 100): Promise<TicketTransfer[]> {
    const snapshot = await this.transferCollection
      .where('status', '==', 'pending')
      .where('expiresAt', '<=', now.toISOString())
      .orderBy('expiresAt', 'asc')
      .limit(Math.max(1, Math.min(500, limit)))
      .get();
    return snapshot.docs.map((document) => toTicketTransfer(document.data()));
  }
}

function toDoc(entitlement: Entitlement): DocumentData {
  return {
    id: entitlement.id,
    orderId: entitlement.orderId,
    eventId: entitlement.eventId,
    organizationId: entitlement.organizationId,
    tierId: entitlement.tierId,
    tierName: entitlement.tierName,
    userId: entitlement.userId,
    unitKind:
      entitlement.unitKind ?? (entitlement.orderId.startsWith('RSVP-') ? 'free_rsvp' : 'paid'),
    currentHolderUserId:
      entitlement.currentHolderUserId === undefined
        ? entitlement.userId
        : entitlement.currentHolderUserId,
    credentialVersion: entitlement.credentialVersion ?? 1,
    pendingTransferId: entitlement.pendingTransferId ?? null,
    ...(entitlement.upgradeFromEntitlementId
      ? { upgradeFromEntitlementId: entitlement.upgradeFromEntitlementId }
      : {}),
    ...(entitlement.upgradedToEntitlementId
      ? { upgradedToEntitlementId: entitlement.upgradedToEntitlementId }
      : {}),
    ...(entitlement.upgradeRefundRequestId
      ? { upgradeRefundRequestId: entitlement.upgradeRefundRequestId }
      : {}),
    ...(entitlement.eligibility ? { eligibility: entitlement.eligibility } : {}),
    ...(entitlement.ticketAddons ? { ticketAddons: entitlement.ticketAddons } : {}),
    holderName: entitlement.holderName,
    status: entitlement.status,
    scanCountAllowed: entitlement.scanCountAllowed,
    scanCount: entitlement.scanCount,
    scannedAt: entitlement.scannedAt,
    refundLock: entitlement.refundLock ?? null,
    version: entitlement.version,
    createdAt: entitlement.createdAt,
    updatedAt: entitlement.updatedAt,
  };
}

function toEntitlement(data: DocumentData): Entitlement {
  return {
    id: data.id as string,
    orderId: data.orderId as string,
    eventId: data.eventId as string,
    organizationId: data.organizationId as string,
    tierId: data.tierId as string,
    tierName: data.tierName as string,
    userId: (data.userId as string | null | undefined) ?? null,
    unitKind: entitlementUnitKind(data.unitKind, data.orderId),
    currentHolderUserId:
      data.currentHolderUserId === undefined
        ? ((data.userId as string | null | undefined) ?? null)
        : (data.currentHolderUserId as string | null),
    credentialVersion: (data.credentialVersion as number | undefined) ?? 1,
    pendingTransferId: (data.pendingTransferId as string | null | undefined) ?? null,
    ...(data.upgradeFromEntitlementId
      ? { upgradeFromEntitlementId: data.upgradeFromEntitlementId as string }
      : {}),
    ...(data.upgradedToEntitlementId
      ? { upgradedToEntitlementId: data.upgradedToEntitlementId as string }
      : {}),
    ...(data.upgradeRefundRequestId
      ? { upgradeRefundRequestId: data.upgradeRefundRequestId as string }
      : {}),
    ...(data.eligibility && typeof data.eligibility === 'object'
      ? { eligibility: data.eligibility as Entitlement['eligibility'] }
      : {}),
    ...(Array.isArray(data.ticketAddons)
      ? { ticketAddons: data.ticketAddons as Entitlement['ticketAddons'] }
      : {}),
    holderName: data.holderName as string,
    status: data.status as EntitlementStatus,
    scanCountAllowed: data.scanCountAllowed as number,
    scanCount: data.scanCount as number,
    scannedAt: data.scannedAt as string[],
    refundLock: (data.refundLock as Entitlement['refundLock'] | undefined) ?? null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}

function toTransferDoc(transfer: TicketTransfer): DocumentData {
  return { ...transfer };
}

function toTicketTransfer(data: DocumentData): TicketTransfer {
  return {
    id: data.id as string,
    entitlementId: data.entitlementId as string,
    eventId: data.eventId as string,
    senderUserId: data.senderUserId as string,
    recipientUserId: (data.recipientUserId as string | null | undefined) ?? null,
    recipientEmailHash: (data.recipientEmailHash as string | null | undefined) ?? null,
    status: data.status as TicketTransferStatus,
    expiresAt: data.expiresAt as string,
    acceptedAt: data.acceptedAt as string | null,
    resolvedAt: data.resolvedAt as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}

function entitlementUnitKind(value: unknown, orderId: unknown): Entitlement['unitKind'] {
  if (value === 'free_rsvp' || value === 'complimentary' || value === 'paid') return value;
  return typeof orderId === 'string' && orderId.startsWith('RSVP-') ? 'free_rsvp' : 'paid';
}

function paginateMemory<T extends { id: string; createdAt: string }>(
  items: T[],
  query: PaginationQuery,
): Page<T> {
  const sorted = items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const start = query.cursor
    ? Math.max(0, sorted.findIndex((item) => item.id === query.cursor) + 1)
    : 0;
  const page = sorted.slice(start, start + query.limit);
  return {
    items: page,
    total: sorted.length,
    nextCursor: start + query.limit < sorted.length ? (page.at(-1)?.id ?? null) : null,
  };
}
