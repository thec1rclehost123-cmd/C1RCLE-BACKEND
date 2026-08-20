import { InvalidOperationError, ForbiddenError, NotFoundError } from '../../domain/errors.js';
import { bumpVersion } from '../../domain/identity.js';
import type { ServiceDeps, ActorContext } from '../context.js';
import type { EntityId } from '../../domain/identity.js';
import type {
  DoorSale,
  DoorSaleCreateInput,
  DoorSaleCategory,
  DoorSaleStatus,
  DoorSalePaymentMode,
} from '../../domain/models/door-sale.js';
import {
  createDoorSale,
} from '../../domain/models/door-sale.js';
import type {
  CoverWallet,
  CoverWalletTxn,
  CoverWalletCreateInput,
  CoverWalletCreditInput,
  CoverWalletDebitInput,
} from '../../domain/models/cover-wallet.js';
import {
  createCoverWallet,
  computeTerminationTime,
  isWalletActive,
  canWalletDebit,
  applyCredit,
  applyDebit,
} from '../../domain/models/cover-wallet.js';

/**
 * ─── Door Service (Phase 5) ─────────────────────────────────────────────────────
 *
 * Walk-in and dine-in sales at the door. Price recalculated server-side.
 * Idempotent via client-supplied idempotency key.
 */

export interface DoorServiceDeps {
  doorSales: ServiceDeps['repositories']['doorSales'];
  events: ServiceDeps['repositories']['events'];
  catalog: ServiceDeps['repositories']['catalog'];
  coverWallets: ServiceDeps['repositories']['coverWallets'];
  coverWalletTxns: ServiceDeps['repositories']['coverWalletTxns'];
  config: ServiceDeps['config'];
  logger: ServiceDeps['logger'];
  outbox: ServiceDeps['outbox'];
  adminAudit: ServiceDeps['adminAudit'];
  pricing: ServiceDeps['pricing'];
}

export interface DoorService {
  createWalkIn(input: CreateWalkInInput, actor: ActorContext): Promise<DoorSale>;
  createDineIn(input: CreateDineInInput, actor: ActorContext): Promise<DoorSale>;
  voidSale(saleId: EntityId, reason: string, actor: ActorContext): Promise<DoorSale>;
  refundSale(saleId: EntityId, amountPaise: number, actor: ActorContext): Promise<DoorSale>;
  getSale(saleId: EntityId, actor: ActorContext): Promise<DoorSale | null>;
  listSales(eventId: EntityId, actor: ActorContext, filters?: DoorSaleFilters): Promise<DoorSale[]>;
  getEventStats(eventId: EntityId, actor: ActorContext): Promise<DoorSaleStats>;
}

export interface CreateWalkInInput {
  eventId: EntityId;
  guestName: string;
  guestPhone?: string;
  guestAge?: number;
  gender?: string;
  contact?: string;
  totalGuests: number;
  gate?: string;
  paymentMode: 'cash' | 'card' | 'upi' | 'other';
  idempotencyKey: string;
}

export interface CreateDineInInput {
  eventId: EntityId;
  guestName: string;
  guestPhone?: string;
  guestAge?: number;
  gender?: string;
  contact?: string;
  totalGuests: number;
  tableNumber: string;
  gate?: string;
  paymentMode: 'cash' | 'card' | 'upi' | 'other';
  idempotencyKey: string;
}

export interface DoorSaleFilters {
  category?: DoorSaleCategory;
  status?: DoorSaleStatus;
  gate?: string;
  paymentMode?: string;
  createdBy?: EntityId;
  from?: Date;
  to?: Date;
}

export interface DoorSaleStats {
  totalSales: number;
  totalRevenue: number;
  walkinCount: number;
  dineinCount: number;
  walkinRevenue: number;
  dineinRevenue: number;
  byPaymentMode: Record<string, { count: number; revenue: number }>;
}

function createDoorServiceImpl(deps: DoorServiceDeps): DoorService {
  const { doorSales, events, catalog, coverWallets, coverWalletTxns, config, logger, outbox, adminAudit, pricing } = deps;

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

  async function createWalkIn(input: CreateWalkInInput, actor: ActorContext): Promise<DoorSale> {
    const event = await events.findById(input.eventId);
    if (!event) throw new NotFoundError('Event', input.eventId);
    requireOrgAccess(actor, event.organizationId);
    
    // Check idempotency
    const existing = await doorSales.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
    
    // Get walk-in price from catalog
    const walkInTier = await catalog.findWalkInTier(event.id);
    if (!walkInTier) {
      throw new InvalidOperationError('Walk-in tier not configured for this event');
    }
    
    const amountPaise = walkInTier.priceInPaise;
    
    const saleInput: DoorSaleCreateInput = {
      eventId: input.eventId,
      organizationId: actor.organizationId,
      venueId: event.venueId,
      category: 'walkin',
      guestName: input.guestName,
      guestPhone: input.guestPhone ?? null,
      guestAge: input.guestAge ?? null,
      gender: input.gender ?? null,
      contact: input.contact ?? null,
      totalGuests: input.totalGuests,
      tableNumber: null,
      gate: input.gate ?? null,
      paymentMode: input.paymentMode,
      amountPaise,
      createdBy: actor.userId,
      createdByName: actor.userId,
      idempotencyKey: input.idempotencyKey,
    };
    
    const sale = createDoorSale(saleInput);
    const created = await doorSales.create(sale);
    
    // If cover wallet exists, debit it
    const wallet = await coverWallets.findByEventAndUser(event.id, actor.userId);
    if (wallet && isWalletActive(wallet)) {
      if (canWalletDebit(wallet, amountPaise)) {
        await coverWallets.debit({
          walletId: wallet.id,
          amount: amountPaise,
          referenceId: created.id,
          referenceType: 'door_sale',
          operatorUid: actor.userId,
          operatorName: actor.userId,
          description: `Walk-in entry: ${walkInTier.name}`,
          idempotencyKey: `${input.idempotencyKey}-debit`,
          deviceId: null,
        });
      }
    }
    
    await adminAudit.write(auditRecord(actor, 'door_sale.create', 'door_sale', created.id, undefined, created));
    
    return created;
  }

  async function createDineIn(input: CreateDineInInput, actor: ActorContext): Promise<DoorSale> {
    const event = await events.findById(input.eventId);
    if (!event) throw new NotFoundError('Event', input.eventId);
    requireOrgAccess(actor, event.organizationId);
    
    // Check idempotency
    const existing = await doorSales.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
    
    // Get dine-in price from catalog
    const dineInTier = await catalog.findDineInTier(event.id);
    if (!dineInTier) {
      throw new InvalidOperationError('Dine-in tier not configured for this event');
    }
    
    const amountPaise = dineInTier.priceInPaise;
    
    const saleInput: DoorSaleCreateInput = {
      eventId: input.eventId,
      organizationId: actor.organizationId,
      venueId: event.venueId,
      category: 'dinein',
      guestName: input.guestName,
      guestPhone: input.guestPhone ?? null,
      guestAge: input.guestAge ?? null,
      gender: input.gender ?? null,
      contact: input.contact ?? null,
      totalGuests: input.totalGuests,
      tableNumber: input.tableNumber,
      gate: input.gate ?? null,
      paymentMode: input.paymentMode,
      amountPaise,
      createdBy: actor.userId,
      createdByName: actor.userId,
      idempotencyKey: input.idempotencyKey,
    };
    
    const sale = createDoorSale(saleInput);
    const created = await doorSales.create(sale);
    
    // If cover wallet exists, debit it
    const wallet = await coverWallets.findByEventAndUser(event.id, actor.userId);
    if (wallet && isWalletActive(wallet)) {
      if (canWalletDebit(wallet, amountPaise)) {
        await coverWallets.debit({
          walletId: wallet.id,
          amount: amountPaise,
          referenceId: created.id,
          referenceType: 'door_sale',
          operatorUid: actor.userId,
          operatorName: actor.userId,
          description: `Dine-in entry: ${dineInTier.name}`,
          idempotencyKey: `${input.idempotencyKey}-debit`,
          deviceId: null,
        });
      }
    }
    
    await adminAudit.write(auditRecord(actor, 'door_sale.create', 'door_sale', created.id, undefined, created));
    
    return created;
  }

  async function voidSale(saleId: EntityId, reason: string, actor: ActorContext): Promise<DoorSale> {
    const sale = await doorSales.findById(saleId);
    if (!sale) throw new NotFoundError('Door sale', saleId);
    requireOrgAccess(actor, sale.organizationId);
    
    if (sale.status !== 'active') {
      throw new InvalidOperationError('Can only void active sales');
    }
    
    const voided = await doorSales.voidSale(saleId, actor.userId, reason);
    if (!voided) throw new NotFoundError('Door sale', saleId);
    
    // If cover wallet was debited, refund it
    if (sale.amountPaise > 0) {
      const wallet = await coverWallets.findByEventAndUser(sale.eventId, sale.createdBy);
      if (wallet && isWalletActive(wallet)) {
        await coverWallets.refund(wallet.id, sale.amountPaise, saleId, `${saleId}-void`, actor.userId, `Void: ${reason}`);
      }
    }
    
    await adminAudit.write(auditRecord(actor, 'door_sale.void', 'door_sale', saleId, sale, voided));
    
    return voided;
  }

  async function refundSale(saleId: EntityId, amountPaise: number, actor: ActorContext): Promise<DoorSale> {
    const sale = await doorSales.findById(saleId);
    if (!sale) throw new NotFoundError('Door sale', saleId);
    requireOrgAccess(actor, sale.organizationId);
    
    if (sale.status !== 'active') {
      throw new InvalidOperationError('Can only refund active sales');
    }
    
    if (amountPaise > sale.amountPaise) {
      throw new InvalidOperationError('Refund amount exceeds sale amount');
    }
    
    const refunded = await doorSales.refundSale(saleId, actor.userId, amountPaise);
    if (!refunded) throw new NotFoundError('Door sale', saleId);
    
    // Refund cover wallet if applicable
    const wallet = await coverWallets.findByEventAndUser(sale.eventId, sale.createdBy);
    if (wallet && isWalletActive(wallet)) {
      await coverWallets.refund(wallet.id, amountPaise, saleId, `${saleId}-refund`, actor.userId, `Refund: ${amountPaise} paise`);
    }
    
    await adminAudit.write(auditRecord(actor, 'door_sale.refund', 'door_sale', saleId, sale, refunded));
    
    return refunded;
  }

  async function getSale(saleId: EntityId, actor: ActorContext): Promise<DoorSale | null> {
    const sale = await doorSales.findById(saleId);
    if (!sale) return null;
    requireOrgAccess(actor, sale.organizationId);
    return sale;
  }

  async function listSales(eventId: EntityId, actor: ActorContext, filters?: DoorSaleFilters): Promise<DoorSale[]> {
    const event = await events.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    requireOrgAccess(actor, event.organizationId);
    
    // Use repository to find with filters
    // For now, return all and filter in memory (repository should support this)
    const allSales = await doorSales.findByEvent(eventId, { limit: 1000, cursor: null } as any);
    
    let filtered = allSales.items;
    
    if (filters?.category) {
      filtered = filtered.filter(s => s.category === filters.category);
    }
    if (filters?.status) {
      filtered = filtered.filter(s => s.status === filters.status);
    }
    if (filters?.gate) {
      filtered = filtered.filter(s => s.gate === filters.gate);
    }
    if (filters?.paymentMode) {
      filtered = filtered.filter(s => s.paymentMode === filters.paymentMode);
    }
    if (filters?.createdBy) {
      filtered = filtered.filter(s => s.createdBy === filters.createdBy);
    }
    if (filters?.from) {
      filtered = filtered.filter(s => new Date(s.createdAt) >= filters.from!);
    }
    if (filters?.to) {
      filtered = filtered.filter(s => new Date(s.createdAt) <= filters.to!);
    }
    
    return filtered;
  }

  async function getEventStats(eventId: EntityId, actor: ActorContext): Promise<DoorSaleStats> {
    const event = await events.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    requireOrgAccess(actor, event.organizationId);
    
    return doorSales.getEventStats(eventId);
  }

  return {
    createWalkIn,
    createDineIn,
    voidSale,
    refundSale,
    getSale,
    listSales,
    getEventStats,
  };
}

function requireOrgAccess(actor: ActorContext, organizationId: EntityId): void {
  if (actor.organizationId !== organizationId) {
    throw new ForbiddenError('Cross-tenant access denied');
  }
}

export function createDoorService(deps: DoorServiceDeps): DoorService {
  return createDoorServiceImpl(deps);
}