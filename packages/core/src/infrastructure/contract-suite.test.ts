import { describe, expect, it, beforeEach } from 'vitest';

import { VersionConflictError } from '../domain/errors.js';
import type { EntityId } from '../domain/identity.js';
import type {
  ScanLedgerRepository,
  EventCodeRepository,
  ScannerSessionRepository,
  DoorSaleRepository,
  CoverWalletRepository,
  CoverWalletTxnRepository,
  CoverWalletReconciliationRepository,
  Page,
  PaginationQuery,
  TxContext,
} from '../domain/ports/repositories.js';
import type { ScanLedger, ScanLedgerStatus, ScanDenyReason } from '../domain/models/scan-ledger.js';
import type { EventCode, EventCodeStatus, EventCodeCreateInput, ScannerSession } from '../domain/models/event-code.js';
import type { DoorSale, DoorSaleCreateInput, DoorSaleCategory, DoorSaleStatus } from '../domain/models/door-sale.js';
import type { CoverWallet, CoverWalletTxn, CoverWalletCreateInput, CoverWalletCreditInput, CoverWalletDebitInput } from '../domain/models/cover-wallet.js';
import type { CoverWalletReconciliation } from '../domain/models/cover-wallet-reconciliation.js';
import { MemoryScanLedgerRepository } from './memory/memory-scan-ledger-repository.js';
import { MemoryEventCodeRepository, MemoryScannerSessionRepository } from './memory/memory-event-code-repository.js';
import { MemoryDoorSaleRepository } from './memory/memory-door-sale-repository.js';
import { MemoryCoverWalletRepository, MemoryCoverWalletTxnRepository, MemoryCoverWalletReconciliationRepository, sharedTxns } from './memory/memory-cover-wallet-repository.js';
import { createScanLedger } from '../domain/models/scan-ledger.js';
import { createEventCode } from '../domain/models/event-code.js';
import { createDoorSale } from '../domain/models/door-sale.js';
import { createCoverWallet } from '../domain/models/cover-wallet.js';
import { createReconciliation } from '../domain/models/cover-wallet-reconciliation.js';

let memoryRepos: {
  scanLedger: MemoryScanLedgerRepository;
  eventCodes: MemoryEventCodeRepository;
  scannerSessions: MemoryScannerSessionRepository;
  doorSales: MemoryDoorSaleRepository;
  coverWallets: MemoryCoverWalletRepository;
  coverWalletTxns: MemoryCoverWalletTxnRepository;
  coverWalletReconciliations: MemoryCoverWalletReconciliationRepository;
};

beforeEach(() => {
    // Clear shared state
    sharedTxns.clear();
    
    memoryRepos = {
      scanLedger: new MemoryScanLedgerRepository(),
      eventCodes: new MemoryEventCodeRepository(),
      scannerSessions: new MemoryScannerSessionRepository(),
      doorSales: new MemoryDoorSaleRepository(),
      coverWallets: new MemoryCoverWalletRepository(),
      coverWalletTxns: new MemoryCoverWalletTxnRepository(),
      coverWalletReconciliations: new MemoryCoverWalletReconciliationRepository(),
    };
  });

/**
 * Contract suite tests for all Phase 5 repository implementations.
 * Run against both memory and Firestore adapters to ensure identical behavior.
 */

function createTestScanLedger(): any {
  return createScanLedger({
    eventId: 'evt_test' as EntityId,
    organizationId: 'org_test' as EntityId,
    venueId: 'venue_test' as EntityId,
    entitlementId: 'ent_test' as EntityId,
    doorSaleId: null,
    entryType: 'general',
    tierName: 'VIP',
    tierId: 'tier_vip' as EntityId,
    operatorUid: 'usr_operator' as EntityId,
    operatorName: 'John Operator',
    operatorRole: 'door_staff',
    gate: 'Gate A',
    deviceId: 'device_123',
    deviceName: 'iPhone 15',
    deviceBound: true,
    guestName: 'Jane Guest',
    guestEmail: 'jane@example.com',
    guestPhone: '+1234567890',
    scannedAt: new Date().toISOString(),
    admittedCount: 1,
    scanCountUsed: 1,
    scanCountAllowed: 1,
    isOffline: false,
    offlineDeviceId: null,
  });
}

function createTestEventCodeInput(): EventCodeCreateInput {
  return {
    eventId: 'evt_test' as EntityId,
    organizationId: 'org_test' as EntityId,
    venueId: 'venue_test' as EntityId,
    type: 'full',
    gate: 'Gate A',
    createdBy: 'usr_admin' as EntityId,
    createdByName: 'Admin User',
    maxDevices: 5,
    allowReuse: false,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
}

function createTestEventCode(): any {
  return createEventCode(createTestEventCodeInput());
}

function createTestDoorSaleInput(): any {
  return {
    eventId: 'evt_test' as EntityId,
    organizationId: 'org_test' as EntityId,
    venueId: 'venue_test' as EntityId,
    category: 'walkin',
    guestName: 'John Doe',
    guestPhone: '+1234567890',
    guestAge: 25,
    gender: 'male',
    contact: 'john@example.com',
    totalGuests: 2,
    tableNumber: null,
    gate: 'Gate A',
    paymentMode: 'cash',
    amountPaise: 50000,
    createdBy: 'usr_operator' as EntityId,
    createdByName: 'Operator',
    idempotencyKey: 'idem_walkin_123',
  };
}

function createTestDoorSale(): any {
  return createDoorSale(createTestDoorSaleInput());
}

function createTestCoverWalletInput(): any {
  return {
    userId: 'usr_guest' as EntityId,
    eventId: 'evt_test' as EntityId,
    organizationId: 'org_test' as EntityId,
    venueId: 'venue_test' as EntityId,
    openingBalance: 100000,
  };
}

function createTestCoverWallet(): any {
  return createCoverWallet(createTestCoverWalletInput());
}

function createTestReconciliationInput(): any {
  return {
    eventId: 'evt_test' as EntityId,
    organizationId: 'org_test' as EntityId,
    venueId: 'venue_test' as EntityId,
    reconciliationDate: '2026-08-20',
    walletId: 'cw_test' as EntityId,
    userId: 'usr_guest' as EntityId,
    expectedBalance: 50000,
    actualBalance: 50000,
    periodCredits: 100000,
    periodDebits: 50000,
    periodRefunds: 0,
    periodTxnCount: 10,
    discrepancies: [],
  };
}

function createTestReconciliation(): any {
  return createReconciliation(createTestReconciliationInput());
}

function runRepositoryContractTests(repoName: string, getRepos: () => {
  scanLedger: any;
  eventCodes: any;
  scannerSessions: any;
  doorSales: any;
  coverWallets: any;
  coverWalletTxns: any;
  coverWalletReconciliations: any;
}) {
  describe(`${repoName} contract suite`, () => {
    let repos: ReturnType<typeof getRepos>;
    
    beforeEach(() => {
      repos = getRepos();
    });

    describe('ScanLedgerRepository', () => {
      it('creates and finds a scan ledger', async () => {
        const scan = createTestScanLedger();
        await repos.scanLedger.create(scan);
        const found = await repos.scanLedger.findById(scan.id);
        expect(found).toEqual(scan);
      });

      it('finds by event and entitlement for duplicate detection', async () => {
        const scan = createTestScanLedger();
        await repos.scanLedger.create(scan);
        const found = await repos.scanLedger.findByEventAndEntitlement(scan.eventId, scan.entitlementId!);
        expect(found).toEqual(scan);
      });

      it('returns null for non-existent scan', async () => {
        const found = await repos.scanLedger.findById('non_existent' as any);
        expect(found).toBeNull();
      });

      it('updates status with deny reason', async () => {
        const scan = createTestScanLedger();
        await repos.scanLedger.create(scan);
        const updated = await repos.scanLedger.markDenied(scan.id, 'already_used', 'Ticket already scanned');
        expect(updated?.status).toBe('denied');
        expect(updated?.denyReason).toBe('already_used');
        expect(updated?.denyMessage).toBe('Ticket already scanned');
      });

      it('marks consumed', async () => {
        const scan = createTestScanLedger();
        await repos.scanLedger.create(scan);
        const updated = await repos.scanLedger.markConsumed(scan.id);
        expect(updated?.status).toBe('consumed');
      });

      it('paginates by event', async () => {
        for (let i = 0; i < 5; i++) {
          const scan = createTestScanLedger();
          scan.id = `scan_${i}`;
          await repos.scanLedger.create(scan);
        }
        const page = await repos.scanLedger.findByEvent('evt_test', { limit: 3, cursor: null });
        expect(page.items.length).toBe(3);
        expect(page.nextCursor).not.toBeNull();
      });
    });

    describe('EventCodeRepository', () => {
      it('creates and finds event code', async () => {
        const input = createTestEventCodeInput();
        const created = await repos.eventCodes.create(input);
        const found = await repos.eventCodes.findById(created.id);
        expect(found).toEqual(created);
      });

      it('finds by human-readable code', async () => {
        const input = createTestEventCodeInput();
        const created = await repos.eventCodes.create(input);
        const found = await repos.eventCodes.findByCode(created.code);
        expect(found).toEqual(created);
      });

      it('finds active codes by event', async () => {
        const input = createTestEventCodeInput();
        const created = await repos.eventCodes.create(input);
        const active = await repos.eventCodes.findActiveByEvent(created.eventId);
        expect(active.length).toBe(1);
      });

      it('revokes code', async () => {
        const input = createTestEventCodeInput();
        const created = await repos.eventCodes.create(input);
        const revoked = await repos.eventCodes.revoke(created.id, 'security_compromise');
        expect(revoked?.status).toBe('revoked');
        expect(revoked?.revokedReason).toBe('security_compromise');
      });
    });

    describe('ScannerSessionRepository', () => {
      it('creates session with token', async () => {
        const code = createTestEventCode();
        await repos.eventCodes.create(code);
        
        const result = await repos.scannerSessions.create({
          codeId: code.id,
          codeData: { id: code.id, code: code.code, eventId: code.eventId, venueId: code.venueId, type: code.type, gate: code.gate, maxDevices: code.maxDevices, allowReuse: code.allowReuse },
          deviceId: 'device_123',
          deviceName: 'iPhone 15',
          createdBy: 'usr_staff',
          createdByName: 'Staff Member',
          sessionType: 'staff',
        });
        
        expect(result.session).toBeDefined();
        expect(result.sessionToken).toBeDefined();
        expect(result.sessionId).toBeDefined();
        expect(result.sessionExpiresAt).toBeDefined();
      });

      it('validates session by token hash', async () => {
        const code = createTestEventCode();
        await repos.eventCodes.create(code);
        
        const result = await repos.scannerSessions.create({
          codeId: code.id,
          codeData: { id: code.id, code: code.code, eventId: code.eventId, venueId: code.venueId, type: code.type, gate: code.gate, maxDevices: code.maxDevices, allowReuse: code.allowReuse },
          deviceId: 'device_123',
          deviceName: 'iPhone 15',
          createdBy: 'usr_staff',
          createdByName: 'Staff Member',
          sessionType: 'staff',
        });
        
        const crypto = await import('crypto');
        const tokenHash = crypto.createHash('sha256').update(result.sessionToken).digest('hex');
        const found = await repos.scannerSessions.findByTokenHash(tokenHash);
        expect(found).toEqual(result.session);
      });

      it('revokes session', async () => {
        const code = createTestEventCode();
        await repos.eventCodes.create(code);
        
        const result = await repos.scannerSessions.create({
          codeId: code.id,
          codeData: { id: code.id, code: code.code, eventId: code.eventId, venueId: code.venueId, type: code.type, gate: code.gate, maxDevices: code.maxDevices, allowReuse: code.allowReuse },
          deviceId: 'device_123',
          deviceName: 'iPhone 15',
          createdBy: 'usr_staff',
          createdByName: 'Staff Member',
          sessionType: 'staff',
        });
        
        const revoked = await repos.scannerSessions.revoke(result.sessionId, 'shift_ended');
        expect(revoked?.revokedAt).toBeDefined();
        expect(revoked?.revokedReason).toBe('shift_ended');
      });
    });

    describe('DoorSaleRepository', () => {
      it('creates door sale with idempotency', async () => {
        const input = createTestDoorSaleInput();
        const created = await repos.doorSales.create(input);
        expect(created.id).toBeDefined();
        expect(created.idempotencyKey).toBe(input.idempotencyKey);
        
        // Second create with same idempotency key should return existing
        const duplicate = await repos.doorSales.create(input);
        expect(duplicate.id).toBe(created.id);
      });

      it('finds by idempotency key', async () => {
        const input = createTestDoorSaleInput();
        const created = await repos.doorSales.create(input);
        const found = await repos.doorSales.findByIdempotencyKey(input.idempotencyKey);
        expect(found).toEqual(created);
      });

      it('voids sale', async () => {
        const input = createTestDoorSaleInput();
        const created = await repos.doorSales.create(input);
        const voided = await repos.doorSales.voidSale(created.id, 'usr_admin', 'customer_left');
        expect(voided?.status).toBe('voided');
        expect(voided?.voidReason).toBe('customer_left');
      });

      it('refunds sale', async () => {
        const input = createTestDoorSaleInput();
        const created = await repos.doorSales.create(input);
        const refunded = await repos.doorSales.refundSale(created.id, 'usr_admin', 25000);
        expect(refunded?.status).toBe('refunded');
        expect(refunded?.refundedAmountPaise).toBe(25000);
      });

      it('gets event stats', async () => {
        const input1 = createTestDoorSaleInput();
        input1.idempotencyKey = 'idem_walkin_1';
        const sale1 = await repos.doorSales.create(input1);
        sale1.category = 'walkin';
        sale1.amountPaise = 50000;
        sale1.paymentMode = 'cash';
        await repos.doorSales.create(input1);
        
        const input2 = createTestDoorSaleInput();
        input2.idempotencyKey = 'idem_dinein_1';
        const sale2 = await repos.doorSales.create(input2);
        sale2.id = 'sale_2';
        sale2.category = 'dinein';
        sale2.amountPaise = 100000;
        sale2.paymentMode = 'card';
        await repos.doorSales.create(input2);
        
        const stats = await repos.doorSales.getEventStats('evt_test');
        expect(stats.totalSales).toBe(2);
        expect(stats.walkinCount).toBe(1);
        expect(stats.dineinCount).toBe(1);
        expect(stats.totalRevenue).toBe(150000);
      });
    });

    describe('CoverWalletRepository', () => {
      it('creates wallet and enforces one per user per event', async () => {
        const input = createTestCoverWalletInput();
        const wallet = await repos.coverWallets.create(input);
        
        // Second create for same user/event should fail
        const duplicateInput = createTestCoverWalletInput();
        duplicateInput.userId = input.userId;
        duplicateInput.eventId = input.eventId;
        duplicateInput.openingBalance = 50000;
        await expect(repos.coverWallets.create(duplicateInput)).rejects.toThrow('Wallet already exists');
      });

      it('credits wallet atomically', async () => {
        const input = createTestCoverWalletInput();
        const wallet = await repos.coverWallets.create(input);
        
        const result = await repos.coverWallets.credit({
          walletId: wallet.id,
          amount: 50000,
          referenceId: 'topup_123',
          referenceType: 'topup',
          operatorUid: 'usr_admin',
          operatorName: 'Admin',
          description: 'Top-up',
          idempotencyKey: 'idem_credit_1',
        });
        
        expect(result.wallet.balance).toBe(150000);
        expect(result.wallet.totalCredits).toBe(150000);
        expect(result.txn.type).toBe('credit');
        expect(result.txn.amount).toBe(50000);
      });

      it('debits wallet with velocity limit', async () => {
        const input = createTestCoverWalletInput();
        input.openingBalance = 100000;
        const wallet = await repos.coverWallets.create(input);
        
        // First debit
        await repos.coverWallets.debit({
          walletId: wallet.id,
          amount: 10000,
          referenceId: 'charge_1',
          referenceType: 'cover_charge',
          operatorUid: 'usr_operator',
          operatorName: 'Operator',
          description: 'Entry charge',
          idempotencyKey: 'idem_debit_1',
          deviceId: 'device_1',
        });
        
        // 3 debits within 1 minute should work
        for (let i = 2; i <= 3; i++) {
          await repos.coverWallets.debit({
            walletId: wallet.id,
            amount: 5000,
            referenceId: `charge_${i}`,
            referenceType: 'cover_charge',
            operatorUid: 'usr_operator',
            operatorName: 'Operator',
            description: 'Entry charge',
            idempotencyKey: `idem_debit_${i}`,
            deviceId: 'device_1',
          });
        }
        
        // 4th debit within 1 minute should fail
        await expect(repos.coverWallets.debit({
          walletId: wallet.id,
          amount: 5000,
          referenceId: 'charge_4',
          referenceType: 'cover_charge',
          operatorUid: 'usr_operator',
          operatorName: 'Operator',
          description: 'Entry charge',
          idempotencyKey: 'idem_debit_4',
          deviceId: 'device_1',
        })).rejects.toThrow('Velocity limit exceeded');
      });

      it('refunds wallet', async () => {
        const input = createTestCoverWalletInput();
        input.openingBalance = 50000;
        const wallet = await repos.coverWallets.create(input);
        
        await repos.coverWallets.refund(wallet.id, 10000, 'charge_1', 'idem_refund_1', 'usr_admin', 'Refund for cancelled entry');
        const updated = await repos.coverWallets.findById(wallet.id);
        expect(updated?.balance).toBe(60000);
        expect(updated?.totalRefunds).toBe(10000);
      });
    });

    describe('CoverWalletTxnRepository', () => {
      it('creates and finds transaction by idempotency key', async () => {
        const wallet = createTestCoverWallet();
        await repos.coverWallets.create(wallet);
        
        const result = await repos.coverWallets.credit({
          walletId: wallet.id,
          amount: 10000,
          referenceId: null,
          referenceType: null,
          operatorUid: 'usr_admin',
          operatorName: 'Admin',
          description: 'Test credit',
          idempotencyKey: 'idem_txn_1',
        });
        
        const txnById = await repos.coverWalletTxns.findById(result.txn.id);
        expect(txnById).toEqual(result.txn);
        
        const txnByIdem = await repos.coverWalletTxns.findByIdempotencyKey('idem_txn_1');
        expect(txnByIdem).toEqual(result.txn);
      });

      it('finds by wallet with pagination', async () => {
        const wallet = createTestCoverWallet();
        await repos.coverWallets.create(wallet);
        
        await repos.coverWallets.credit({ walletId: wallet.id, amount: 10000, referenceId: null, referenceType: null, operatorUid: 'usr_admin', operatorName: 'Admin', description: 'Credit 1', idempotencyKey: 'idem_1' });
        await repos.coverWallets.credit({ walletId: wallet.id, amount: 20000, referenceId: null, referenceType: null, operatorUid: 'usr_admin', operatorName: 'Admin', description: 'Credit 2', idempotencyKey: 'idem_2' });
        
        const page = await repos.coverWalletTxns.findByWallet(wallet.id, { limit: 10, cursor: null });
        expect(page.items.length).toBe(2);
      });
    });

    describe('CoverWalletReconciliationRepository', () => {
      it('creates and resolves reconciliation', async () => {
        const input = createTestReconciliationInput();
        const recon = createReconciliation(input);
        const created = await repos.coverWalletReconciliations.create(input);
        expect(created).toEqual(recon);
        
        // Duplicate reconciliation for same event+date should fail
        await expect(repos.coverWalletReconciliations.create(input)).rejects.toThrow('Reconciliation already exists');
      });

      it('resolves reconciliation', async () => {
        const input = createTestReconciliationInput();
        const recon = createReconciliation(input);
        await repos.coverWalletReconciliations.create(input);
        
        const resolved = await repos.coverWalletReconciliations.resolve(recon.id, 'usr_auditor', 'Verified');
        expect(resolved?.status).toBe('resolved');
        expect(resolved?.resolvedBy).toBe('usr_auditor');
        expect(resolved?.resolutionNotes).toBe('Verified');
      });

      it('finds pending reconciliations', async () => {
        const input = createTestReconciliationInput();
        const recon = createReconciliation(input);
        await repos.coverWalletReconciliations.create(input);
        
        const pending = await repos.coverWalletReconciliations.findPending('org_test');
        expect(pending.length).toBe(1);
      });
    });

    describe('Optimistic locking', () => {
      it('rejects stale version on scan ledger', async () => {
        const scan = createTestScanLedger();
        await repos.scanLedger.create(scan);
        
        // Simulate concurrent modification by incrementing version
        const stale = { ...scan, version: scan.version + 5 };
        await expect(repos.scanLedger.create(stale)).rejects.toThrow('Version conflict');
      });

      it('rejects stale version on cover wallet', async () => {
        const wallet = createTestCoverWallet();
        await repos.coverWallets.create(wallet);
        
        const stale = { ...wallet, version: wallet.version + 5 };
        await expect(repos.coverWallets.create(stale)).rejects.toThrow('Version conflict');
      });
    });
  });
}

describe('Memory repository contract suite', () => {
  runRepositoryContractTests('Memory', () => memoryRepos);
});