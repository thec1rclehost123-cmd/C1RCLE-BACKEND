import { compareAndSet } from './compare-and-set.js';
import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type { CoverWallet, CoverWalletTxn, CoverWalletStatus, CoverWalletTxnType, CoverWalletTxnStatus } from '../../domain/models/cover-wallet.js';
import type { CoverWalletReconciliation } from '../../domain/models/cover-wallet-reconciliation.js';
import type {
  CoverWalletRepository,
  CoverWalletTxnRepository,
  CoverWalletReconciliationRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore, Query, FieldValue } from 'firebase-admin/firestore';

const WALLET_COLLECTION = 'v2_cover_wallets';
const TXN_COLLECTION = 'v2_cover_wallet_txns';
const IDEMPOTENCY_COLLECTION = 'v2_cover_wallet_idempotency';

export class FirestoreCoverWalletRepository implements CoverWalletRepository {
  constructor(private readonly db: Firestore) {}

  private get walletCollection() {
    return this.db.collection(WALLET_COLLECTION);
  }

  private get txnCollection() {
    return this.db.collection(TXN_COLLECTION);
  }

  async create(wallet: CoverWallet): Promise<CoverWallet> {
    await this.walletCollection.doc(wallet.id).set(toWalletDoc(wallet));
    await this.db.collection('v2_cover_wallet_by_event_user').doc(`${wallet.eventId}|${wallet.userId}`).set({ walletId: wallet.id });
    return wallet;
  }

  async findById(id: EntityId): Promise<CoverWallet | null> {
    const snap = await this.walletCollection.doc(id).get();
    return snap.exists ? toWallet(snap.data()!) : null;
  }

  async findByEventAndUser(eventId: EntityId, userId: EntityId): Promise<CoverWallet | null> {
    const idDoc = await this.db.collection('v2_cover_wallet_by_event_user').doc(`${eventId}|${userId}`).get();
    if (!idDoc.exists) return null;
    const walletId = idDoc.data()!.walletId;
    const snap = await this.walletCollection.doc(walletId).get();
    return snap.exists ? toWallet(snap.data()!) : null;
  }

  async findByEvent(eventId: EntityId, input: PaginationQuery): Promise<Page<CoverWallet>> {
    const base = this.walletCollection.where('eventId', '==', eventId).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toWallet);
  }

  async findByOrganization(organizationId: EntityId, input: PaginationQuery): Promise<Page<CoverWallet>> {
    const base = this.walletCollection.where('organizationId', '==', organizationId).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toWallet);
  }

  async findActiveByEvent(eventId: EntityId): Promise<CoverWallet[]> {
    const snap = await this.walletCollection.where('eventId', '==', eventId).where('status', '==', 'active').get();
    return snap.docs.map((doc) => toWallet(doc.data()));
  }

  async credit(input: {
    walletId: EntityId;
    amount: number;
    referenceId: EntityId | null;
    referenceType: string | null;
    operatorUid: EntityId | null;
    operatorName: string | null;
    description: string | null;
    idempotencyKey: string;
  }): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }> {
    return this.db.runTransaction(async (transaction) => {
      const walletRef = this.walletCollection.doc(input.walletId);
      const walletSnap = await transaction.get(walletRef);
      if (!walletSnap.exists) throw new Error('Wallet not found');
      const wallet = toWallet(walletSnap.data()!);

      const newBalance = wallet.balance + input.amount;
      const updatedWallet: CoverWallet = {
        ...wallet,
        balance: newBalance,
        totalCredits: wallet.totalCredits + input.amount,
        lastTxnAt: new Date().toISOString(),
        lastCreditAt: new Date().toISOString(),
        version: wallet.version + 1,
        updatedAt: new Date().toISOString(),
      };

      const txn: CoverWalletTxn = {
        id: `txn-${input.walletId}-${Date.now()}`,
        walletId: input.walletId,
        eventId: wallet.eventId,
        organizationId: wallet.organizationId,
        venueId: wallet.venueId,
        userId: wallet.userId,
        type: 'credit',
        amount: input.amount,
        balanceAfter: newBalance,
        status: 'committed',
        idempotencyKey: input.idempotencyKey,
        referenceId: input.referenceId,
        referenceType: input.referenceType,
        deviceId: null,
        operatorUid: input.operatorUid,
        operatorName: input.operatorName,
        description: input.description,
        failureReason: null,
        processedAt: new Date().toISOString(),
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      transaction.set(this.walletCollection.doc(input.walletId), toWalletDoc(updatedWallet));
      transaction.set(this.db.collection(TXN_COLLECTION).doc(txn.id), toTxnDoc(txn));
      transaction.set(this.db.collection('v2_cover_wallet_idempotency').doc(input.idempotencyKey), { txnId: txn.id });

      return { wallet: updatedWallet, txn };
    });
  }

  async debit(input: {
    walletId: EntityId;
    amount: number;
    referenceId: EntityId | null;
    referenceType: string | null;
    operatorUid: EntityId | null;
    operatorName: string | null;
    description: string | null;
    idempotencyKey: string;
    deviceId: string | null;
  }): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }> {
    return this.db.runTransaction(async (transaction) => {
      const walletRef = this.walletCollection.doc(input.walletId);
      const walletSnap = await transaction.get(walletRef);
      if (!walletSnap.exists) throw new Error('Wallet not found');
      const wallet = toWallet(walletSnap.data()!);

      if (wallet.balance < input.amount) throw new Error('Insufficient balance');

      const newBalance = wallet.balance - input.amount;
      const updatedWallet: CoverWallet = {
        ...wallet,
        balance: newBalance,
        totalDebits: wallet.totalDebits + input.amount,
        lastTxnAt: new Date().toISOString(),
        lastDebitAt: new Date().toISOString(),
        status: newBalance === 0 ? 'terminated' : wallet.status,
        terminatedAt: newBalance === 0 ? new Date().toISOString() : wallet.terminatedAt,
        terminationReason: newBalance === 0 ? 'balance_depleted' : wallet.terminationReason,
        version: wallet.version + 1,
        updatedAt: new Date().toISOString(),
      };

      const txn: CoverWalletTxn = {
        id: `txn-${input.walletId}-${Date.now()}`,
        walletId: input.walletId,
        eventId: wallet.eventId,
        organizationId: wallet.organizationId,
        venueId: wallet.venueId,
        userId: wallet.userId,
        type: 'debit',
        amount: -input.amount,
        balanceAfter: newBalance,
        status: 'committed',
        idempotencyKey: input.idempotencyKey,
        referenceId: input.referenceId,
        referenceType: input.referenceType,
        deviceId: input.deviceId,
        operatorUid: input.operatorUid,
        operatorName: input.operatorName,
        description: input.description,
        failureReason: null,
        processedAt: new Date().toISOString(),
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      transaction.set(this.walletCollection.doc(input.walletId), toWalletDoc(updatedWallet));
      transaction.set(this.db.collection(TXN_COLLECTION).doc(txn.id), toTxnDoc(txn));
      transaction.set(this.db.collection('v2_cover_wallet_idempotency').doc(input.idempotencyKey), { txnId: txn.id });

      return { wallet: updatedWallet, txn };
    });
  }

  async refund(walletId: EntityId, amount: number, referenceId: EntityId, idempotencyKey: string, operatorUid: EntityId, description: string): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }> {
    return this.db.runTransaction(async (transaction) => {
      const walletRef = this.walletCollection.doc(walletId);
      const walletSnap = await transaction.get(walletRef);
      if (!walletSnap.exists) throw new Error('Wallet not found');
      const wallet = toWallet(walletSnap.data()!);

      const updatedWallet: CoverWallet = {
        ...wallet,
        balance: wallet.balance + amount,
        totalRefunds: wallet.totalRefunds + amount,
        lastTxnAt: new Date().toISOString(),
        version: wallet.version + 1,
        updatedAt: new Date().toISOString(),
      };

      const txn: CoverWalletTxn = {
        id: `txn-${walletId}-${Date.now()}`,
        walletId,
        eventId: wallet.eventId,
        organizationId: wallet.organizationId,
        venueId: wallet.venueId,
        userId: wallet.userId,
        type: 'refund',
        amount,
        balanceAfter: updatedWallet.balance,
        status: 'committed',
        idempotencyKey,
        referenceId,
        referenceType: 'refund',
        deviceId: null,
        operatorUid,
        operatorName: operatorUid,
        description,
        failureReason: null,
        processedAt: new Date().toISOString(),
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      transaction.set(this.walletCollection.doc(walletId), toWalletDoc(updatedWallet));
      transaction.set(this.db.collection(TXN_COLLECTION).doc(txn.id), toTxnDoc(txn));
      transaction.set(this.db.collection('v2_cover_wallet_idempotency').doc(idempotencyKey), { txnId: txn.id });

      return { wallet: updatedWallet, txn };
    });
  }

  async adjust(walletId: EntityId, amount: number, idempotencyKey: string, operatorUid: EntityId, description: string): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }> {
    return this.db.runTransaction(async (transaction) => {
      const walletRef = this.walletCollection.doc(walletId);
      const walletSnap = await transaction.get(walletRef);
      if (!walletSnap.exists) throw new Error('Wallet not found');
      const wallet = toWallet(walletSnap.data()!);

      if (wallet.balance + amount < 0) throw new Error('Adjustment would result in negative balance');

      const updatedWallet: CoverWallet = {
        ...wallet,
        balance: wallet.balance + amount,
        lastTxnAt: new Date().toISOString(),
        version: wallet.version + 1,
        updatedAt: new Date().toISOString(),
      };

      const txn: CoverWalletTxn = {
        id: `txn-${walletId}-${Date.now()}`,
        walletId,
        eventId: wallet.eventId,
        organizationId: wallet.organizationId,
        venueId: wallet.venueId,
        userId: wallet.userId,
        type: 'adjustment',
        amount,
        balanceAfter: updatedWallet.balance,
        status: 'committed',
        idempotencyKey,
        referenceId: null,
        referenceType: 'adjustment',
        deviceId: null,
        operatorUid,
        operatorName: operatorUid,
        description,
        failureReason: null,
        processedAt: new Date().toISOString(),
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      transaction.set(this.walletCollection.doc(walletId), toWalletDoc(updatedWallet));
      transaction.set(this.db.collection(TXN_COLLECTION).doc(txn.id), toTxnDoc(txn));
      transaction.set(this.db.collection('v2_cover_wallet_idempotency').doc(idempotencyKey), { txnId: txn.id });

      return { wallet: updatedWallet, txn };
    });
  }

  async terminate(walletId: EntityId, reason: string): Promise<CoverWallet | null> {
    const ref = this.walletCollection.doc(walletId);
    await ref.update({ status: 'terminated', terminatedAt: new Date().toISOString(), terminationReason: reason, updatedAt: new Date().toISOString() });
    const snap = await ref.get();
    return snap.exists ? toWallet(snap.data()!) : null;
  }

  async close(walletId: EntityId): Promise<CoverWallet | null> {
    const ref = this.walletCollection.doc(walletId);
    await ref.update({ status: 'closed', updatedAt: new Date().toISOString() });
    const snap = await ref.get();
    return snap.exists ? toWallet(snap.data()!) : null;
  }

  async getBalance(walletId: EntityId): Promise<number | null> {
    const snap = await this.walletCollection.doc(walletId).get();
    return snap.exists ? toWallet(snap.data()!).balance : null;
  }

  async isActive(walletId: EntityId): Promise<boolean> {
    const snap = await this.walletCollection.doc(walletId).get();
    return snap.exists ? toWallet(snap.data()!).status === 'active' : false;
  }

  async countRecentDebits(deviceId: string, since: Date): Promise<number> {
    const snap = await this.db.collection(TXN_COLLECTION)
      .where('deviceId', '==', deviceId)
      .where('type', '==', 'debit')
      .where('createdAt', '>=', since.toISOString())
      .count()
      .get();
    return snap.data().count;
  }

  async getEventStats(eventId: EntityId): Promise<{
    totalWallets: number;
    activeWallets: number;
    terminatedWallets: number;
    totalBalance: number;
    totalCredits: number;
    totalDebits: number;
    totalRefunds: number;
    avgBalance: number;
    byStatus: Record<string, number>;
  }> {
    const snap = await this.walletCollection.where('eventId', '==', eventId).get();
    const wallets = snap.docs.map((doc) => toWallet(doc.data()));
    const byStatus: Record<string, number> = {};
    for (const w of wallets) {
      byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
    }
    return {
      totalWallets: wallets.length,
      activeWallets: wallets.filter((w) => w.status === 'active').length,
      terminatedWallets: wallets.filter((w) => w.status === 'terminated' || w.status === 'closed').length,
      totalBalance: wallets.reduce((sum, w) => sum + w.balance, 0),
      totalCredits: wallets.reduce((sum, w) => sum + w.totalCredits, 0),
      totalDebits: wallets.reduce((sum, w) => sum + w.totalDebits, 0),
      totalRefunds: wallets.reduce((sum, w) => sum + w.totalRefunds, 0),
      avgBalance: wallets.length > 0 ? wallets.reduce((sum, w) => sum + w.balance, 0) / wallets.length : 0,
      byStatus,
    };
  }
}

export class FirestoreCoverWalletTxnRepository implements CoverWalletTxnRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(TXN_COLLECTION);
  }

  async create(txn: CoverWalletTxn): Promise<CoverWalletTxn> {
    await this.collection.doc(txn.id).set(toTxnDoc(txn));
    await this.db.collection('v2_cover_wallet_idempotency').doc(txn.idempotencyKey).set({ txnId: txn.id });
    return txn;
  }

  async findById(id: EntityId): Promise<CoverWalletTxn | null> {
    const snap = await this.collection.doc(id).get();
    return snap.exists ? toTxn(snap.data()!) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<CoverWalletTxn | null> {
    const idDoc = await this.db.collection('v2_cover_wallet_idempotency').doc(idempotencyKey).get();
    if (!idDoc.exists) return null;
    const txnId = idDoc.data()!.txnId;
    const snap = await this.collection.doc(txnId).get();
    return snap.exists ? toTxn(snap.data()!) : null;
  }

  async findByWallet(walletId: EntityId, input: PaginationQuery): Promise<any> {
    const base = this.db.collection(TXN_COLLECTION).where('walletId', '==', walletId).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toTxn);
  }

  async findByEvent(eventId: EntityId, input: PaginationQuery): Promise<any> {
    const base = this.db.collection(TXN_COLLECTION).where('eventId', '==', eventId).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toTxn);
  }

  async findByType(type: string, input: PaginationQuery): Promise<any> {
    const base = this.db.collection(TXN_COLLECTION).where('type', '==', type).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toTxn);
  }

  async findByReference(referenceId: EntityId, referenceType: string): Promise<any[]> {
    const snap = await this.db.collection(TXN_COLLECTION).where('referenceId', '==', referenceId).where('referenceType', '==', referenceType).get();
    return snap.docs.map((doc) => toTxn(doc.data()));
  }

  async updateStatus(id: EntityId, status: string, failureReason?: string, processedAt?: Date): Promise<any | null> {
    const ref = this.collection.doc(id);
    const updates: Record<string, unknown> = { status, updatedAt: new Date().toISOString() };
    if (failureReason) updates.failureReason = failureReason;
    if (processedAt) updates.processedAt = processedAt.toISOString();
    await ref.update(updates);
    const snap = await ref.get();
    return snap.exists ? toTxn(snap.data()!) : null;
  }

  async getEventStats(eventId: EntityId): Promise<{
    totalCredits: number;
    totalDebits: number;
    totalRefunds: number;
    totalAdjustments: number;
    netFlow: number;
    txnCount: number;
  }> {
    const snap = await this.db.collection(TXN_COLLECTION).where('eventId', '==', eventId).get();
    const txns = snap.docs.map((doc) => toTxn(doc.data()));
    const committed = txns.filter((t) => t.status === 'committed');
    return {
      totalCredits: committed.filter((t) => t.type === 'credit').reduce((sum, t) => sum + t.amount, 0),
      totalDebits: committed.filter((t) => t.type === 'debit').reduce((sum, t) => sum + Math.abs(t.amount), 0),
      totalRefunds: committed.filter((t) => t.type === 'refund').reduce((sum, t) => sum + t.amount, 0),
      totalAdjustments: committed.filter((t) => t.type === 'adjustment').reduce((sum, t) => sum + t.amount, 0),
      netFlow: committed.reduce((sum, t) => sum + t.amount, 0),
      txnCount: txns.length,
    };
  }

  async countRecentDebits(deviceId: string, since: Date): Promise<number> {
    const snap = await this.collection
      .where('deviceId', '==', deviceId)
      .where('type', '==', 'debit')
      .where('createdAt', '>=', since.toISOString())
      .count()
      .get();
    return snap.data().count;
  }
}

export class FirestoreCoverWalletReconciliationRepository implements CoverWalletReconciliationRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection('v2_cover_wallet_reconciliations');
  }

  async create(recon: any): Promise<any> {
    await this.collection.doc(recon.id).set(toDoc(recon));
    return recon;
  }

  async findById(id: string): Promise<any | null> {
    const snap = await this.collection.doc(id).get();
    return snap.exists ? toRecon(snap.data()!) : null;
  }

  async findByEventAndDate(eventId: string, date: string): Promise<any | null> {
    const snap = await this.collection.where('eventId', '==', eventId).where('reconciliationDate', '==', date).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return doc ? toRecon(doc.data()) : null;
  }

  async findByEvent(eventId: string, input: any): Promise<any> {
    const base = this.collection.where('eventId', '==', eventId).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toRecon);
  }

  async findByOrganization(organizationId: string, input: any): Promise<any> {
    const base = this.collection.where('organizationId', '==', organizationId).orderBy('createdAt', 'desc');
    return paginateQuery(base, input, toRecon);
  }

  async findPending(organizationId: string): Promise<any[]> {
    const snap = await this.collection.where('organizationId', '==', organizationId).where('status', '==', 'pending').get();
    return snap.docs.map((doc) => toRecon(doc.data()));
  }

  async findWithDiscrepancies(organizationId: string): Promise<any[]> {
    const snap = await this.collection.where('organizationId', '==', organizationId).get();
    return snap.docs.map((doc) => toRecon(doc.data())).filter((r) => r.discrepancies.length > 0);
  }

  async resolve(id: string, resolvedBy: string, notes: string): Promise<any | null> {
    const ref = this.collection.doc(id);
    await ref.update({
      status: 'resolved',
      resolvedBy,
      resolvedAt: new Date().toISOString(),
      resolutionNotes: notes,
      updatedAt: new Date().toISOString(),
    });
    const snap = await ref.get();
    return snap.exists ? toRecon(snap.data()!) : null;
  }

  async getOrganizationStats(organizationId: string, from: Date, to: Date): Promise<{
    totalReconciliations: number;
    completedCount: number;
    discrepancyCount: number;
    resolvedCount: number;
    totalDiscrepancyAmount: number;
  }> {
    const snap = await this.collection
      .where('organizationId', '==', organizationId)
      .where('createdAt', '>=', from.toISOString())
      .where('createdAt', '<=', to.toISOString())
      .get();
    const recons = snap.docs.map((doc) => toRecon(doc.data()));
    return {
      totalReconciliations: recons.length,
      completedCount: recons.filter((r) => r.status === 'completed').length,
      discrepancyCount: recons.filter((r) => r.status === 'discrepancy').length,
      resolvedCount: recons.filter((r) => r.status === 'resolved').length,
      totalDiscrepancyAmount: recons.reduce((sum, r) => sum + Math.abs(r.discrepancy), 0),
    };
  }
}

function toWalletDoc(wallet: CoverWallet): DocumentData {
  return {
    id: wallet.id,
    userId: wallet.userId,
    eventId: wallet.eventId,
    organizationId: wallet.organizationId,
    venueId: wallet.venueId,
    balance: wallet.balance,
    openingBalance: wallet.openingBalance,
    totalCredits: wallet.totalCredits,
    totalDebits: wallet.totalDebits,
    totalRefunds: wallet.totalRefunds,
    status: wallet.status,
    terminatedAt: wallet.terminatedAt,
    terminationReason: wallet.terminationReason,
    lastTxnAt: wallet.lastTxnAt,
    lastCreditAt: wallet.lastCreditAt,
    lastDebitAt: wallet.lastDebitAt,
    metadata: wallet.metadata,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

function toWallet(data: DocumentData): CoverWallet {
  return {
    id: data.id as string,
    userId: data.userId as string,
    eventId: data.eventId as string,
    organizationId: data.organizationId as string,
    venueId: data.venueId as string | null,
    balance: data.balance as number,
    openingBalance: data.openingBalance as number,
    totalCredits: data.totalCredits as number,
    totalDebits: data.totalDebits as number,
    totalRefunds: data.totalRefunds as number,
    status: data.status as CoverWalletStatus,
    terminatedAt: data.terminatedAt as string | null,
    terminationReason: data.terminationReason as string | null,
    lastTxnAt: data.lastTxnAt as string | null,
    lastCreditAt: data.lastCreditAt as string | null,
    lastDebitAt: data.lastDebitAt as string | null,
    metadata: data.metadata as Record<string, unknown>,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}

function toTxnDoc(txn: CoverWalletTxn): DocumentData {
  return {
    id: txn.id,
    walletId: txn.walletId,
    eventId: txn.eventId,
    organizationId: txn.organizationId,
    venueId: txn.venueId,
    userId: txn.userId,
    type: txn.type,
    amount: txn.amount,
    balanceAfter: txn.balanceAfter,
    status: txn.status,
    idempotencyKey: txn.idempotencyKey,
    referenceId: txn.referenceId,
    referenceType: txn.referenceType,
    deviceId: txn.deviceId,
    operatorUid: txn.operatorUid,
    operatorName: txn.operatorName,
    description: txn.description,
    failureReason: txn.failureReason,
    processedAt: txn.processedAt,
    version: txn.version,
    createdAt: txn.createdAt,
    updatedAt: txn.updatedAt,
  };
}

function toTxn(data: DocumentData): CoverWalletTxn {
  return {
    id: data.id as string,
    walletId: data.walletId as string,
    eventId: data.eventId as string,
    organizationId: data.organizationId as string,
    venueId: data.venueId as string | null,
    userId: data.userId as string,
    type: data.type as CoverWalletTxnType,
    amount: data.amount as number,
    balanceAfter: data.balanceAfter as number,
    status: data.status as CoverWalletTxnStatus,
    idempotencyKey: data.idempotencyKey as string,
    referenceId: data.referenceId as string | null,
    referenceType: data.referenceType as string | null,
    deviceId: data.deviceId as string | null,
    operatorUid: data.operatorUid as string | null,
    operatorName: data.operatorName as string | null,
    description: data.description as string | null,
    failureReason: data.failureReason as string | null,
    processedAt: data.processedAt as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}

function toDoc(recon: any): DocumentData {
  return {
    id: recon.id,
    eventId: recon.eventId,
    organizationId: recon.organizationId,
    venueId: recon.venueId,
    reconciliationDate: recon.reconciliationDate,
    walletId: recon.walletId,
    userId: recon.userId,
    status: recon.status,
    expectedBalance: recon.expectedBalance,
    actualBalance: recon.actualBalance,
    discrepancy: recon.discrepancy,
    periodCredits: recon.periodCredits,
    periodDebits: recon.periodDebits,
    periodRefunds: recon.periodRefunds,
    periodTxnCount: recon.periodTxnCount,
    discrepancies: recon.discrepancies,
    resolvedBy: recon.resolvedBy,
    resolvedAt: recon.resolvedAt,
    resolutionNotes: recon.resolutionNotes,
    version: recon.version,
    createdAt: recon.createdAt,
    updatedAt: recon.updatedAt,
  };
}

function toRecon(data: DocumentData): any {
  return {
    id: data.id as string,
    eventId: data.eventId as string,
    organizationId: data.organizationId as string,
    venueId: data.venueId as string | null,
    reconciliationDate: data.reconciliationDate as string,
    walletId: data.walletId as string | null,
    userId: data.userId as string | null,
    status: data.status as 'pending' | 'completed' | 'discrepancy' | 'resolved',
    expectedBalance: data.expectedBalance as number,
    actualBalance: data.actualBalance as number,
    discrepancy: data.discrepancy as number,
    periodCredits: data.periodCredits as number,
    periodDebits: data.periodDebits as number,
    periodRefunds: data.periodRefunds as number,
    periodTxnCount: data.periodTxnCount as number,
    discrepancies: (data.discrepancies as any[]) ?? [],
    resolvedBy: data.resolvedBy as string | null,
    resolvedAt: data.resolvedAt as string | null,
    resolutionNotes: data.resolutionNotes as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}