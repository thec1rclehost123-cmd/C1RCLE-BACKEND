import { InvalidOperationError, ForbiddenError, NotFoundError } from '../../domain/errors.js';
import { bumpVersion } from '../../domain/identity.js';
import type { ServiceDeps, ActorContext } from '../context.js';
import type { EntityId } from '../../domain/identity.js';
import type {
  CoverWallet,
  CoverWalletTxn,
  CoverWalletCreateInput,
  CoverWalletCreditInput,
  CoverWalletDebitInput,
  CoverWalletStatus,
  CoverWalletTxnType,
  CoverWalletTxnStatus,
} from '../../domain/models/cover-wallet.js';
import {
  createCoverWallet,
  computeTerminationTime,
  isWalletActive,
  isWalletTerminated,
  canWalletDebit,
  applyCredit,
  applyDebit,
  applyRefund,
} from '../../domain/models/cover-wallet.js';
import type {
  CoverWalletReconciliation,
  CoverWalletReconciliationCreateInput,
  CoverWalletReconciliationDiscrepancy,
  ReconciliationStatus,
} from '../../domain/models/cover-wallet-reconciliation.js';
import {
  createReconciliation,
  resolveReconciliation,
} from '../../domain/models/cover-wallet-reconciliation.js';

/**
 * ─── Cover Wallet Service (Phase 5) ─────────────────────────────────────────────
 *
 * Pre-paid wallet for venue entry + cover charges. All amounts in integer paise.
 * Invariants enforced:
 * - balance >= 0 (terminated if balance == 0)
 * - credit/debit via atomic transactions (balance + txn)
 * - idempotency keys on every mutation
 * - velocity limit: max 3 debits/min per device
 * - terminated wallets reject all mutations
 * - offline debits blocked
 * - termination time = next day 05:00 local (tzOffset +05:30)
 * - daily reconciliation for audit
 */

export interface CoverWalletServiceDeps {
  coverWallets: ServiceDeps['repositories']['coverWallets'];
  coverWalletTxns: ServiceDeps['repositories']['coverWalletTxns'];
  coverWalletReconciliations: ServiceDeps['repositories']['coverWalletReconciliations'];
  events: ServiceDeps['repositories']['events'];
  config: ServiceDeps['config'];
  logger: ServiceDeps['logger'];
  outbox: ServiceDeps['outbox'];
  adminAudit: ServiceDeps['adminAudit'];
}

export interface CoverWalletService {
  // Wallet lifecycle
  createWallet(input: CreateWalletInput, actor: ActorContext): Promise<CoverWallet>;
  getWallet(walletId: EntityId, actor: ActorContext): Promise<CoverWallet | null>;
  getWalletByEventAndUser(eventId: EntityId, userId: EntityId, actor: ActorContext): Promise<CoverWallet | null>;
  listWallets(eventId: EntityId, actor: ActorContext, filters?: WalletFilters): Promise<CoverWallet[]>;
  
  // Balance operations
  creditWallet(input: CreditWalletInput, actor: ActorContext): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }>;
  debitWallet(input: DebitWalletInput, actor: ActorContext): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }>;
  refundWallet(input: RefundWalletInput, actor: ActorContext): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }>;
  adjustWallet(input: AdjustWalletInput, actor: ActorContext): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }>;
  
  // Wallet status
  terminateWallet(walletId: EntityId, reason: string, actor: ActorContext): Promise<CoverWallet>;
  closeWallet(walletId: EntityId, actor: ActorContext): Promise<CoverWallet>;
  
  // Transaction history
  getTransactions(walletId: EntityId, actor: ActorContext, filters?: TxnFilters): Promise<CoverWalletTxn[]>;
  getTransaction(txnId: EntityId, actor: ActorContext): Promise<CoverWalletTxn | null>;
  
  // Reconciliation
  runReconciliation(input: RunReconciliationInput, actor: ActorContext): Promise<CoverWalletReconciliation>;
  getReconciliation(reconciliationId: EntityId, actor: ActorContext): Promise<CoverWalletReconciliation | null>;
  listReconciliations(eventId: EntityId, actor: ActorContext, filters?: ReconciliationFilters): Promise<CoverWalletReconciliation[]>;
  resolveReconciliation(reconciliationId: EntityId, notes: string, actor: ActorContext): Promise<CoverWalletReconciliation>;
  
  // Stats
  getEventStats(eventId: EntityId, actor: ActorContext): Promise<WalletEventStats>;
  getOrganizationStats(organizationId: EntityId, from: Date, to: Date, actor: ActorContext): Promise<WalletOrgStats>;
}

export interface CreateWalletInput {
  eventId: EntityId;
  userId: EntityId;
  openingBalance: number; // paise
  metadata?: Record<string, any>;
}

export interface CreditWalletInput {
  walletId: EntityId;
  amount: number; // paise
  referenceId?: EntityId;
  referenceType?: string;
  description?: string;
  idempotencyKey: string;
}

export interface DebitWalletInput {
  walletId: EntityId;
  amount: number; // paise
  referenceId?: EntityId;
  referenceType?: string;
  description?: string;
  idempotencyKey: string;
  deviceId?: string;
}

export interface RefundWalletInput {
  walletId: EntityId;
  amount: number; // paise
  referenceId: EntityId;
  description?: string;
  idempotencyKey: string;
}

export interface AdjustWalletInput {
  walletId: EntityId;
  amount: number; // paise (positive or negative)
  description: string;
  idempotencyKey: string;
}

export interface WalletFilters {
  status?: CoverWalletStatus;
  userId?: EntityId;
  from?: Date;
  to?: Date;
  minBalance?: number;
  maxBalance?: number;
}

export interface TxnFilters {
  type?: CoverWalletTxnType;
  status?: CoverWalletTxnStatus;
  referenceId?: EntityId;
  referenceType?: string;
  deviceId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

export interface RunReconciliationInput {
  eventId: EntityId;
  reconciliationDate: string; // YYYY-MM-DD
  walletId?: EntityId;
  userId?: EntityId;
}

export interface ReconciliationFilters {
  status?: ReconciliationStatus;
  walletId?: EntityId;
  userId?: EntityId;
  from?: Date;
  to?: Date;
  hasDiscrepancy?: boolean;
}

export interface WalletEventStats {
  totalWallets: number;
  activeWallets: number;
  terminatedWallets: number;
  totalBalance: number;
  totalCredits: number;
  totalDebits: number;
  totalRefunds: number;
  avgBalance: number;
  byStatus: Record<string, number>;
}

export interface WalletOrgStats {
  totalWallets: number;
  totalBalance: number;
  totalCredits: number;
  totalDebits: number;
  totalRefunds: number;
  totalReconciliations: number;
  completedReconciliations: number;
  discrepancyReconciliations: number;
  totalDiscrepancyAmount: number;
}

function createCoverWalletServiceImpl(deps: CoverWalletServiceDeps): CoverWalletService {
  const { coverWallets, coverWalletTxns, coverWalletReconciliations, events, config, logger, outbox, adminAudit } = deps;

  function auditRecord(actor: ActorContext, action: string, targetType: string, targetId: EntityId, before?: any, after?: any): any {
    return {
      id: `audit-${targetId}-${Date.now()}`,
      adminId: actor.userId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      action,
      targetType,
      targetId,
      before,
      after,
      occurredAt: Date.now(),
    };
  }

  async function createWallet(input: CreateWalletInput, actor: ActorContext): Promise<CoverWallet> {
    const event = await events.findById(input.eventId);
    if (!event) throw new NotFoundError('Event', input.eventId);
    requireOrgAccess(actor, event.organizationId);
    
    // Check if wallet already exists for this user/event
    const existing = await coverWallets.findByEventAndUser(input.eventId, input.userId);
    if (existing) {
      throw new InvalidOperationError('Wallet already exists for this user and event');
    }
    
    const walletInput: CoverWalletCreateInput = {
      userId: input.userId,
      eventId: input.eventId,
      organizationId: actor.organizationId,
      venueId: event.venueId,
      openingBalance: input.openingBalance,
      metadata: input.metadata,
    };
    
    const wallet = createCoverWallet(walletInput);
    const created = await coverWallets.create(wallet);
    
    // Create opening credit transaction
    await coverWalletTxns.create({
      walletId: created.id,
      eventId: input.eventId,
      organizationId: actor.organizationId,
      venueId: event.venueId,
      userId: input.userId,
      type: 'credit',
      amount: input.openingBalance,
      balanceAfter: input.openingBalance,
      status: 'committed',
      idempotencyKey: `wallet-open-${created.id}`,
      referenceId: null,
      referenceType: 'wallet_activation',
      deviceId: null,
      operatorUid: actor.userId,
      operatorName: actor.userId,
      description: 'Wallet activation',
      processedAt: new Date().toISOString(),
    } as any);
    
    await adminAudit.write(auditRecord(actor, 'cover_wallet.create', 'cover_wallet', created.id, undefined, created));
    
    return created;
  }

  async function getWallet(walletId: EntityId, actor: ActorContext): Promise<CoverWallet | null> {
    const wallet = await coverWallets.findById(walletId);
    if (!wallet) return null;
    requireOrgAccess(actor, wallet.organizationId);
    return wallet;
  }

  async function getWalletByEventAndUser(eventId: EntityId, userId: EntityId, actor: ActorContext): Promise<CoverWallet | null> {
    const event = await events.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    requireOrgAccess(actor, event.organizationId);
    
    return coverWallets.findByEventAndUser(eventId, userId);
  }

  async function listWallets(eventId: EntityId, actor: ActorContext, filters?: WalletFilters): Promise<CoverWallet[]> {
    const event = await events.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    requireOrgAccess(actor, event.organizationId);
    
    const allWallets = await coverWallets.findByEvent(eventId, { limit: 1000, cursor: null } as any);
    let filtered = allWallets.items;
    
    if (filters?.status) {
      filtered = filtered.filter(w => w.status === filters.status);
    }
    if (filters?.userId) {
      filtered = filtered.filter(w => w.userId === filters.userId);
    }
    if (filters?.from) {
      filtered = filtered.filter(w => new Date(w.createdAt) >= filters.from!);
    }
    if (filters?.to) {
      filtered = filtered.filter(w => new Date(w.createdAt) <= filters.to!);
    }
    if (filters?.minBalance !== undefined) {
      filtered = filtered.filter(w => w.balance >= filters.minBalance!);
    }
    if (filters?.maxBalance !== undefined) {
      filtered = filtered.filter(w => w.balance <= filters.maxBalance!);
    }
    
    return filtered;
  }

  async function creditWallet(input: CreditWalletInput, actor: ActorContext): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }> {
    const wallet = await coverWallets.findById(input.walletId);
    if (!wallet) throw new NotFoundError('Wallet', input.walletId);
    requireOrgAccess(actor, wallet.organizationId);
    
    if (!isWalletActive(wallet)) {
      throw new InvalidOperationError('Cannot credit inactive wallet');
    }
    
    // Check idempotency
    const existingTxn = await coverWalletTxns.findByIdempotencyKey(input.idempotencyKey);
    if (existingTxn) {
      const existingWallet = await coverWallets.findById(existingTxn.walletId);
      return { wallet: existingWallet!, txn: existingTxn };
    }
    
    const result = await coverWallets.credit({
      walletId: input.walletId,
      amount: input.amount,
      referenceId: input.referenceId ?? null,
      referenceType: input.referenceType ?? null,
      operatorUid: actor.userId,
      operatorName: actor.userId,
      description: input.description ?? null,
      idempotencyKey: input.idempotencyKey,
    });
    
    await adminAudit.write(auditRecord(actor, 'cover_wallet.credit', 'cover_wallet', input.walletId, undefined, result.wallet));
    
    return result;
  }

  async function debitWallet(input: DebitWalletInput, actor: ActorContext): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }> {
    const wallet = await coverWallets.findById(input.walletId);
    if (!wallet) throw new NotFoundError('Wallet', input.walletId);
    requireOrgAccess(actor, wallet.organizationId);
    
    if (!isWalletActive(wallet)) {
      throw new InvalidOperationError('Cannot debit inactive wallet');
    }
    
    // Velocity check: max 3 debits/min per device
    if (input.deviceId) {
      const since = new Date(Date.now() - 60 * 1000);
      const recentDebits = await coverWalletTxns.countRecentDebits(input.deviceId, since);
      if (recentDebits >= 3) {
        throw new InvalidOperationError('Velocity limit exceeded: max 3 debits per minute per device');
      }
    }
    
    // Check idempotency
    const existingTxn = await coverWalletTxns.findByIdempotencyKey(input.idempotencyKey);
    if (existingTxn) {
      const existingWallet = await coverWallets.findById(existingTxn.walletId);
      return { wallet: existingWallet!, txn: existingTxn };
    }
    
    const result = await coverWallets.debit({
      walletId: input.walletId,
      amount: input.amount,
      referenceId: input.referenceId ?? null,
      referenceType: input.referenceType ?? null,
      operatorUid: actor.userId,
      operatorName: actor.userId,
      description: input.description ?? null,
      idempotencyKey: input.idempotencyKey,
      deviceId: input.deviceId ?? null,
    });
    
    await adminAudit.write(auditRecord(actor, 'cover_wallet.debit', 'cover_wallet', input.walletId, undefined, result.wallet));
    
    return result;
  }

  async function refundWallet(input: RefundWalletInput, actor: ActorContext): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }> {
    const wallet = await coverWallets.findById(input.walletId);
    if (!wallet) throw new NotFoundError('Wallet', input.walletId);
    requireOrgAccess(actor, wallet.organizationId);
    
    if (!isWalletActive(wallet)) {
      throw new InvalidOperationError('Cannot refund inactive wallet');
    }
    
    // Check idempotency
    const existingTxn = await coverWalletTxns.findByIdempotencyKey(input.idempotencyKey);
    if (existingTxn) {
      const existingWallet = await coverWallets.findById(existingTxn.walletId);
      return { wallet: existingWallet!, txn: existingTxn };
    }
    
    const result = await coverWallets.refund(wallet.id, input.amount, input.referenceId, input.idempotencyKey, actor.userId, input.description ?? 'Refund');
    
    await adminAudit.write(auditRecord(actor, 'cover_wallet.refund', 'cover_wallet', input.walletId, undefined, result.wallet));
    
    return result;
  }

  async function adjustWallet(input: AdjustWalletInput, actor: ActorContext): Promise<{ wallet: CoverWallet; txn: CoverWalletTxn }> {
    const wallet = await coverWallets.findById(input.walletId);
    if (!wallet) throw new NotFoundError('Wallet', input.walletId);
    requireOrgAccess(actor, wallet.organizationId);
    
    if (!isWalletActive(wallet)) {
      throw new InvalidOperationError('Cannot adjust inactive wallet');
    }
    
    if (wallet.balance + input.amount < 0) {
      throw new InvalidOperationError('Adjustment would result in negative balance');
    }
    
    // Check idempotency
    const existingTxn = await coverWalletTxns.findByIdempotencyKey(input.idempotencyKey);
    if (existingTxn) {
      const existingWallet = await coverWallets.findById(existingTxn.walletId);
      return { wallet: existingWallet!, txn: existingTxn };
    }
    
    const result = await coverWallets.adjust(wallet.id, input.amount, input.idempotencyKey, actor.userId, input.description);
    
    await adminAudit.write(auditRecord(actor, 'cover_wallet.adjust', 'cover_wallet', input.walletId, wallet, result.wallet));
    
    return result;
  }

  async function terminateWallet(walletId: EntityId, reason: string, actor: ActorContext): Promise<CoverWallet> {
    const wallet = await coverWallets.findById(walletId);
    if (!wallet) throw new NotFoundError('Wallet', walletId);
    requireOrgAccess(actor, wallet.organizationId);
    
    if (isWalletTerminated(wallet)) {
      throw new InvalidOperationError('Wallet already terminated');
    }
    
    const terminated = await coverWallets.terminate(walletId, reason);
    if (!terminated) throw new NotFoundError('Wallet', walletId);
    
    await adminAudit.write(auditRecord(actor, 'cover_wallet.terminate', 'cover_wallet', walletId, wallet, terminated));
    
    return terminated;
  }

  async function closeWallet(walletId: EntityId, actor: ActorContext): Promise<CoverWallet> {
    const wallet = await coverWallets.findById(walletId);
    if (!wallet) throw new NotFoundError('Wallet', walletId);
    requireOrgAccess(actor, wallet.organizationId);
    
    const closed = await coverWallets.close(walletId);
    if (!closed) throw new NotFoundError('Wallet', walletId);
    
    await adminAudit.write(auditRecord(actor, 'cover_wallet.close', 'cover_wallet', walletId, wallet, closed));
    
    return closed;
  }

  async function getTransactions(walletId: EntityId, actor: ActorContext, filters?: TxnFilters): Promise<CoverWalletTxn[]> {
    const wallet = await coverWallets.findById(walletId);
    if (!wallet) throw new NotFoundError('Wallet', walletId);
    requireOrgAccess(actor, wallet.organizationId);
    
    // For simplicity, use findByWallet and filter in memory
    const allTxns = await coverWalletTxns.findByWallet(walletId, { limit: filters?.limit ?? 100, cursor: filters?.cursor ?? null });
    let filtered = allTxns.items;
    
    if (filters?.type) {
      filtered = filtered.filter(t => t.type === filters.type);
    }
    if (filters?.status) {
      filtered = filtered.filter(t => t.status === filters.status);
    }
    if (filters?.referenceId) {
      filtered = filtered.filter(t => t.referenceId === filters.referenceId);
    }
    if (filters?.referenceType) {
      filtered = filtered.filter(t => t.referenceType === filters.referenceType);
    }
    if (filters?.deviceId) {
      filtered = filtered.filter(t => t.deviceId === filters.deviceId);
    }
    if (filters?.from) {
      filtered = filtered.filter(t => new Date(t.createdAt) >= filters.from!);
    }
    if (filters?.to) {
      filtered = filtered.filter(t => new Date(t.createdAt) <= filters.to!);
    }
    
    return filtered;
  }

  async function getTransaction(txnId: EntityId, actor: ActorContext): Promise<CoverWalletTxn | null> {
    const txn = await coverWalletTxns.findById(txnId);
    if (!txn) return null;
    
    const wallet = await coverWallets.findById(txn.walletId);
    if (!wallet) return null;
    requireOrgAccess(actor, wallet.organizationId);
    
    return txn;
  }

  async function runReconciliation(input: RunReconciliationInput, actor: ActorContext): Promise<CoverWalletReconciliation> {
    const event = await events.findById(input.eventId);
    if (!event) throw new NotFoundError('Event', input.eventId);
    requireOrgAccess(actor, event.organizationId);
    
    // Check if reconciliation already exists for this date
    const existing = await coverWalletReconciliations.findByEventAndDate(input.eventId, input.reconciliationDate);
    if (existing) {
      throw new InvalidOperationError('Reconciliation already exists for this date');
    }
    
    // Get wallets to reconcile
    let wallets: CoverWallet[];
    if (input.walletId) {
      const wallet = await coverWallets.findById(input.walletId);
      if (!wallet) throw new NotFoundError('Wallet', input.walletId);
      wallets = [wallet];
    } else if (input.userId) {
      const wallet = await coverWallets.findByEventAndUser(input.eventId, input.userId);
      if (!wallet) throw new NotFoundError('Wallet', input.userId);
      wallets = [wallet];
    } else {
      const allWallets = await coverWallets.findByEvent(input.eventId, { limit: 1000, cursor: null } as any);
      wallets = allWallets.items;
    }
    
    // Compute expected vs actual
    const discrepancies: CoverWalletReconciliationDiscrepancy[] = [];
    let totalCredits = 0;
    let totalDebits = 0;
    let totalRefunds = 0;
    let totalTxnCount = 0;
    let totalExpectedBalance = 0;
    let totalActualBalance = 0;
    
    for (const wallet of wallets) {
      const txns = await coverWalletTxns.findByWallet(wallet.id, { limit: 10000, cursor: null });
      
      let expectedBalance = wallet.openingBalance;
      let periodCredits = 0;
      let periodDebits = 0;
      let periodRefunds = 0;
      
      for (const txn of txns.items) {
        if (txn.status !== 'committed') continue;
        
        if (txn.type === 'credit') {
          expectedBalance += txn.amount;
          periodCredits += txn.amount;
        } else if (txn.type === 'debit') {
          expectedBalance -= txn.amount;
          periodDebits += txn.amount;
        } else if (txn.type === 'refund') {
          expectedBalance += txn.amount;
          periodRefunds += txn.amount;
        }
        totalTxnCount++;
      }
      
      const actualBalance = wallet.balance;
      const discrepancy = actualBalance - expectedBalance;
      
      if (discrepancy !== 0) {
        discrepancies.push({
          type: 'balance_mismatch',
          walletId: wallet.id,
          userId: wallet.userId,
          expectedAmount: expectedBalance,
          actualAmount: actualBalance,
          transactionId: null,
          description: `Balance mismatch: expected ${expectedBalance}, actual ${actualBalance}`,
        });
      }
      
      totalCredits += periodCredits;
      totalDebits += periodDebits;
      totalRefunds += periodRefunds;
      totalExpectedBalance += expectedBalance;
      totalActualBalance += actualBalance;
    }
    
    const reconInput: CoverWalletReconciliationCreateInput = {
      eventId: input.eventId,
      organizationId: actor.organizationId,
      venueId: event.venueId,
      reconciliationDate: input.reconciliationDate,
      walletId: input.walletId ?? null,
      userId: input.userId ?? null,
      expectedBalance: totalExpectedBalance,
      actualBalance: totalActualBalance,
      periodCredits: totalCredits,
      periodDebits: totalDebits,
      periodRefunds: totalRefunds,
      periodTxnCount: totalTxnCount,
      discrepancies,
    };
    
    const reconciliation = createReconciliation(reconInput);
    const created = await coverWalletReconciliations.create(reconciliation);
    
    await adminAudit.write(auditRecord(actor, 'cover_wallet.reconcile', 'cover_wallet_reconciliation', created.id, undefined, created));
    
    return created;
  }

  async function getReconciliation(reconciliationId: EntityId, actor: ActorContext): Promise<CoverWalletReconciliation | null> {
    const recon = await coverWalletReconciliations.findById(reconciliationId);
    if (!recon) return null;
    requireOrgAccess(actor, recon.organizationId);
    return recon;
  }

  async function listReconciliations(eventId: EntityId, actor: ActorContext, filters?: ReconciliationFilters): Promise<CoverWalletReconciliation[]> {
    const event = await events.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    requireOrgAccess(actor, event.organizationId);
    
    const allRecons = await coverWalletReconciliations.findByEvent(eventId, { limit: 1000, cursor: null } as any);
    let filtered = allRecons.items;
    
    if (filters?.status) {
      filtered = filtered.filter(r => r.status === filters.status);
    }
    if (filters?.walletId) {
      filtered = filtered.filter(r => r.walletId === filters.walletId);
    }
    if (filters?.userId) {
      filtered = filtered.filter(r => r.userId === filters.userId);
    }
    if (filters?.from) {
      filtered = filtered.filter(r => new Date(r.createdAt) >= filters.from!);
    }
    if (filters?.to) {
      filtered = filtered.filter(r => new Date(r.createdAt) <= filters.to!);
    }
    if (filters?.hasDiscrepancy) {
      filtered = filtered.filter(r => r.discrepancies.length > 0);
    }
    
    return filtered;
  }

  async function resolveReconciliation(reconciliationId: EntityId, notes: string, actor: ActorContext): Promise<CoverWalletReconciliation> {
    const recon = await coverWalletReconciliations.findById(reconciliationId);
    if (!recon) throw new NotFoundError('Reconciliation', reconciliationId);
    requireOrgAccess(actor, recon.organizationId);
    
    if (recon.status === 'resolved') {
      throw new InvalidOperationError('Reconciliation already resolved');
    }
    
    const resolved = await coverWalletReconciliations.resolve(reconciliationId, actor.userId, notes);
    if (!resolved) throw new NotFoundError('Reconciliation', reconciliationId);
    
    await adminAudit.write(auditRecord(actor, 'cover_wallet_reconciliation.resolve', 'cover_wallet_reconciliation', reconciliationId, recon, resolved));
    
    return resolved;
  }

  async function getEventStats(eventId: EntityId, actor: ActorContext): Promise<WalletEventStats> {
    const event = await events.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    requireOrgAccess(actor, event.organizationId);
    
    const stats = await coverWallets.getEventStats(eventId);
    return stats;
  }

  async function getOrganizationStats(organizationId: EntityId, from: Date, to: Date, actor: ActorContext): Promise<WalletOrgStats> {
    requireOrgAccess(actor, organizationId);
    
    const [walletStats, reconStats] = await Promise.all([
      coverWallets.getEventStats(organizationId),
      coverWalletReconciliations.getOrganizationStats(organizationId, from, to),
    ]);
    
    return {
      totalWallets: walletStats.totalWallets,
      totalBalance: walletStats.totalBalance,
      totalCredits: walletStats.totalCredits,
      totalDebits: walletStats.totalDebits,
      totalRefunds: walletStats.totalRefunds,
      totalReconciliations: reconStats.totalReconciliations,
      completedReconciliations: reconStats.completedCount,
      discrepancyReconciliations: reconStats.discrepancyCount,
      totalDiscrepancyAmount: reconStats.totalDiscrepancyAmount,
    };
  }

  return {
    createWallet,
    getWallet,
    getWalletByEventAndUser,
    listWallets,
    creditWallet,
    debitWallet,
    refundWallet,
    adjustWallet,
    terminateWallet,
    closeWallet,
    getTransactions,
    getTransaction,
    runReconciliation,
    getReconciliation,
    listReconciliations,
    resolveReconciliation,
    getEventStats,
    getOrganizationStats,
  };
}

function requireOrgAccess(actor: ActorContext, organizationId: EntityId): void {
  if (actor.organizationId !== organizationId) {
    throw new ForbiddenError('Cross-tenant access denied');
  }
}

export function createCoverWalletService(deps: CoverWalletServiceDeps): CoverWalletService {
  return createCoverWalletServiceImpl(deps);
}