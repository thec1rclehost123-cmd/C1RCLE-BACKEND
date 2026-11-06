import { describe, expect, it } from 'vitest';

import { createCoreConfig, type CoreConfig } from '../../config/index.js';
import { ForbiddenError } from '../../domain/errors.js';
import { createPlatformAdmin, type AdminRole } from '../../domain/models/admin-authority.js';
import { createPromoterAssignment } from '../../domain/models/event-catalog.js';
import { createEventCoverAccount } from '../../domain/models/event-cover.js';
import { createOrder } from '../../domain/models/order.js';
import { createOrganization } from '../../domain/models/organization.js';
import { calculatePricing } from '../../domain/models/pricing.js';
import { LoggingEmailSender } from '../../domain/ports/email-sender.js';
import { EchoObjectStorage } from '../../domain/ports/object-storage.js';
import { MemoryPaymentProvider } from '../../domain/ports/payment-provider.js';
import {
  MemoryStaffCredentialProvisioner,
  MemoryStaffRotationStore,
  MemoryStaffUserDirectory,
} from '../../domain/ports/staff-credentials.js';
import { FormatCheckVerificationProvider } from '../../domain/ports/verification.js';
import { MemoryAdminAuditRepository } from '../../infrastructure/memory/memory-audit-repository.js';
import { MemoryEmailDeliveryRepository } from '../../infrastructure/memory/memory-email-delivery-repository.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { buildRepositories } from '../../infrastructure/utils.js';
import { noopLogger } from '../../telemetry/logger.js';
import { InventoryService } from '../inventory/inventory-service.js';
import { PricingService } from '../pricing/pricing-service.js';

import { AdminAuthorityService } from './admin-authority-service.js';
import { AdminOperationsService } from './admin-ops-service.js';

import type { TicketTier } from '../../domain/models/event-catalog.js';
import type {
  EventCatalogRepository,
  PlatformAdminRepository,
} from '../../domain/ports/repositories.js';
import type { MemoryUserAccountRepository } from '../../infrastructure/memory/memory-user-account-repository.js';
import type { ServiceDeps } from '../context.js';

/**
 * ─── Admin operations service — tier/audit contract ─────────────────────────
 *
 * Regression guards for the authority grid and the audit trail:
 *
 *  F1+F2 — `PROMOTER_SUSPEND` / `PROMOTER_REINSTATE` are friendlier-than-claim
 *    bugs: existing code calls `requireAdmin(adminUserId)` (any tier) where the
 *    declared authority contract lists these as TIER2 actions. The lock asserts
 *    a `support`-tier admin is refused outright (ForbiddenError) and only
 *    tier-2+ roles may act.
 *
 *  F3 — every privileged mutation writes an audit record with before/after
 *    state, and a repeat against already-transitioned state is a no-op that
 *    does not double-log.
 *
 *  F4 — platform settings updates are audited too, and the merge-update
 *    contract (only supplied fields overwritten) holds.
 */
describe('AdminOperationsService — promoter & settings authority', () => {
  function makeDeps() {
    const repositories = buildRepositories({
      STORAGE_DRIVER: 'memory',
      FIRESTORE_PROJECT_ID: 'test-project',
    });
    const config: CoreConfig = createCoreConfig({
      redis: { url: 'redis://localhost:6379' },
      firestore: { projectId: 'test-project' },
    });
    const adminAudit = new MemoryAdminAuditRepository();
    const deps: ServiceDeps = {
      config,
      logger: noopLogger,
      outbox: new MemoryOutboxStore(),
      emailDeliveries: new MemoryEmailDeliveryRepository(),
      adminAudit,
      verification: new FormatCheckVerificationProvider(),
      objectStorage: new EchoObjectStorage(),
      emailSender: new LoggingEmailSender(noopLogger),
      userDirectory: new MemoryStaffUserDirectory(),
      paymentProvider: new MemoryPaymentProvider('test_webhook_secret'),
      credentialProvisioner: new MemoryStaffCredentialProvisioner(),
      rotationStore: new MemoryStaffRotationStore(),

      pricing: new PricingService({ eventCatalog: repositories.catalog }),
      inventory: new InventoryService({
        eventCatalog: repositories.catalog,
        cartReservation: repositories.cartReservations,
        order: repositories.orders,
      }),
      repositories,
    };
    return { deps, config, repositories, adminAudit };
  }

  async function seedPromoter(catalog: EventCatalogRepository, promoterId: string, count = 1) {
    for (let i = 0; i < count; i += 1) {
      await catalog.saveAssignment(
        createPromoterAssignment({
          id: `assignment_${promoterId}_${i}`,
          eventId: `event_${i}`,
          promoterId,
          terms: { ratePercent: 10, flatPaise: 0, version: 1 },
          now: new Date('2026-01-01T00:00:00Z'),
        }),
      );
    }
  }

  async function seedAdmin(admins: PlatformAdminRepository, userId: string, role: AdminRole) {
    await admins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
  }

  async function seedPromoterOrganization(
    repositories: ReturnType<typeof buildRepositories>,
    promoterId: string,
  ) {
    await repositories.organizations.save(
      createOrganization({
        id: promoterId,
        name: 'Promoter',
        slug: promoterId,
        ownerId: `user_${promoterId}`,
        capabilities: ['promoter'],
      }),
    );
  }

  it('F1+F2: a support-tier admin cannot suspend or reinstate a promoter', async () => {
    const { deps, repositories } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_support', 'support');
    await seedPromoter(repositories.catalog, 'promoter_1');

    const authority = new AdminAuthorityService(deps);
    const ops = new AdminOperationsService(deps, authority);

    await expect(ops.suspendPromoter('admin_support', 'promoter_1', 'test reason')).rejects.toThrow(
      ForbiddenError,
    );
    await expect(
      ops.reinstatePromoter('admin_support', 'promoter_1', 'test reason'),
    ).rejects.toThrow(ForbiddenError);
  });

  it('F1+F2: ops/finance tiers may suspend and reinstate a promoter', async () => {
    const { deps, repositories } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_ops', 'ops');
    await seedPromoter(repositories.catalog, 'promoter_1');

    const authority = new AdminAuthorityService(deps);
    const ops = new AdminOperationsService(deps, authority);

    const result = await ops.suspendPromoter('admin_ops', 'promoter_1', 'Policy review');
    expect(result.affected).toBe(1);

    const reinstated = await ops.reinstatePromoter('admin_ops', 'promoter_1', 'Review complete');
    expect(reinstated.affected).toBe(1);
  });

  it('F3: suspend/reinstate write exactly one audit record each with before/after', async () => {
    const { deps, repositories, adminAudit } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_ops', 'ops');
    await seedPromoter(repositories.catalog, 'promoter_2', 2);

    const authority = new AdminAuthorityService(deps);
    const ops = new AdminOperationsService(deps, authority);

    await ops.suspendPromoter('admin_ops', 'promoter_2', 'Policy review');

    const suspendedRecords = adminAudit
      .all()
      .filter((r) => r.action === 'PROMOTER_SUSPEND' && r.targetId === 'promoter_2');
    expect(suspendedRecords).toHaveLength(1);
    expect(suspendedRecords[0]?.adminId).toBe('admin_ops');
    expect(suspendedRecords[0]?.reason).toBe('Policy review');
    expect(suspendedRecords[0]?.after).toBeDefined();

    await ops.reinstatePromoter('admin_ops', 'promoter_2', 'Review complete');

    const reinstatedRecords = adminAudit
      .all()
      .filter((r) => r.action === 'PROMOTER_REINSTATE' && r.targetId === 'promoter_2');
    expect(reinstatedRecords).toHaveLength(1);
    expect(reinstatedRecords[0]?.before).toBeDefined();
    expect(reinstatedRecords[0]?.after).toBeDefined();
    expect(reinstatedRecords[0]?.reason).toBe('Review complete');
  });

  it('F3: repeat suspend against already-suspended state is a no-op (affected 0, no second audit)', async () => {
    const { deps, repositories, adminAudit } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_ops', 'ops');
    await seedPromoter(repositories.catalog, 'promoter_3');

    const authority = new AdminAuthorityService(deps);
    const ops = new AdminOperationsService(deps, authority);

    const first = await ops.suspendPromoter('admin_ops', 'promoter_3', 'Policy review');
    expect(first.affected).toBe(1);

    const second = await ops.suspendPromoter('admin_ops', 'promoter_3', 'Retry');
    expect(second.affected).toBe(0);

    const records = adminAudit
      .all()
      .filter((r) => r.action === 'PROMOTER_SUSPEND' && r.targetId === 'promoter_3');
    expect(records).toHaveLength(1);
  });

  it('suspends accepted, active, and invited assignments, blocks the organization, and is idempotent', async () => {
    const { deps, repositories, adminAudit } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_ops', 'ops');
    await seedPromoterOrganization(repositories, 'promoter_current');
    for (const [id, status] of [
      ['accepted_assignment', 'accepted'],
      ['active_assignment', 'active'],
      ['invited_assignment', 'invited'],
    ] as const) {
      await repositories.catalog.saveAssignment(
        createPromoterAssignment({
          id,
          eventId: `event_${id}`,
          promoterId: 'promoter_current',
          status,
          terms: { ratePercent: 10, flatPaise: 0, version: 1 },
        }),
      );
    }

    const authority = new AdminAuthorityService(deps);
    const ops = new AdminOperationsService(deps, authority);
    const suspended = await ops.suspendPromoter('admin_ops', 'promoter_current', 'Policy review');

    expect(suspended.affected).toBe(3);
    expect((await repositories.organizations.getById('promoter_current'))?.status).toBe(
      'suspended',
    );
    expect(await repositories.catalog.listAssignmentsByPromoter('promoter_current')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'accepted_assignment',
          status: 'suspended',
          suspendedFromStatus: 'accepted',
        }),
        expect.objectContaining({
          id: 'active_assignment',
          status: 'suspended',
          suspendedFromStatus: 'active',
        }),
        expect.objectContaining({
          id: 'invited_assignment',
          status: 'suspended',
          suspendedFromStatus: 'invited',
        }),
      ]),
    );
    const outbox = await deps.outbox.listPending();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.type).toBe('promoter.assignments.status_changed');
    expect(outbox[0]?.payload.payload).toMatchObject({
      promoterId: 'promoter_current',
      status: 'suspended',
      affectedAssignments: 3,
    });
    expect(adminAudit.all().filter((entry) => entry.action === 'PROMOTER_SUSPEND')).toHaveLength(1);

    const repeated = await ops.suspendPromoter('admin_ops', 'promoter_current', 'Retry');
    expect(repeated.affected).toBe(0);
    expect(await deps.outbox.listPending()).toHaveLength(1);
    expect(adminAudit.all().filter((entry) => entry.action === 'PROMOTER_SUSPEND')).toHaveLength(1);
  });

  it('reinstates invited assignments as invitations rather than activating them', async () => {
    const { deps, repositories } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_ops', 'ops');
    await seedPromoterOrganization(repositories, 'promoter_invited');
    await repositories.catalog.saveAssignment(
      createPromoterAssignment({
        id: 'invited_assignment',
        eventId: 'event_invited',
        promoterId: 'promoter_invited',
        status: 'invited',
        terms: { ratePercent: 10, flatPaise: 0, version: 1 },
      }),
    );
    const ops = new AdminOperationsService(deps, new AdminAuthorityService(deps));

    await ops.suspendPromoter('admin_ops', 'promoter_invited', 'Policy review');
    await ops.reinstatePromoter('admin_ops', 'promoter_invited', 'Review complete');

    expect((await repositories.organizations.getById('promoter_invited'))?.status).toBe('active');
    expect(await repositories.catalog.getAssignmentById('invited_assignment')).toMatchObject({
      status: 'invited',
      suspendedAt: null,
      suspendedFromStatus: null,
    });
  });

  it('F4: every platform-settings update writes an audit record', async () => {
    const { deps, repositories, adminAudit } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_ops', 'ops');

    const authority = new AdminAuthorityService(deps);
    const ops = new AdminOperationsService(deps, authority);

    await ops.updatePlatformSettings('admin_ops', { maintenanceMode: true });

    const records = adminAudit.all().filter((r) => r.action === 'PLATFORM_SETTINGS_UPDATE');
    expect(records).toHaveLength(1);
    expect(records[0]?.targetType).toBe('platform_settings');
    expect(records[0]?.before).toBeDefined();
    expect(records[0]?.after).toMatchObject({ maintenanceMode: true });
  });

  it('globalLookup finds a user by email, not just by id', async () => {
    const { deps, repositories } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_ops', 'ops');
    (repositories.users as MemoryUserAccountRepository).save({
      id: 'user_1',
      email: 'guest@c1rcle.test',
      name: 'Guest One',
      image: null,
      emailVerified: true,
      role: 'guest',
      createdAt: 0,
      updatedAt: 0,
    });

    const authority = new AdminAuthorityService(deps);
    const ops = new AdminOperationsService(deps, authority);

    const byId = await ops.globalLookup('admin_ops', 'user_1');
    expect(byId).toContainEqual({ type: 'user', id: 'user_1', label: 'guest@c1rcle.test' });

    const byEmail = await ops.globalLookup('admin_ops', 'guest@c1rcle.test');
    expect(byEmail).toContainEqual({ type: 'user', id: 'user_1', label: 'guest@c1rcle.test' });
  });

  it('globalLookup finds an order by its guest-safe booking reference', async () => {
    const { deps, repositories } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_ops', 'ops');
    const ticketTier: TicketTier = {
      id: 'tier_1',
      eventId: 'event_1',
      organizationId: 'org_1',
      name: 'General',
      description: '',
      entryType: 'general',
      currency: 'INR',
      priceInPaise: 100_000,
      quantity: 10,
      status: 'active',
      salesStartAt: null,
      salesEndAt: null,
      maxPerOrder: null,
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const order = createOrder({
      id: 'order_support_lookup',
      eventId: 'event_1',
      organizationId: 'org_1',
      userId: 'user_1',
      contact: { name: 'Guest', email: 'guest@example.com', phone: '9876543210' },
      pricing: calculatePricing({ lines: [{ tier: ticketTier, quantity: 1 }] }),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    await repositories.orders.save(order);

    const authority = new AdminAuthorityService(deps);
    const ops = new AdminOperationsService(deps, authority);

    if (!order.bookingReference) throw new Error('Expected a booking reference');
    await expect(ops.globalLookup('admin_ops', order.bookingReference)).resolves.toContainEqual({
      type: 'order',
      id: order.id,
      label: order.bookingReference,
    });
  });

  it('reverses one cover redemption only behind approval and writes one reasoned audit record', async () => {
    const { deps, repositories, adminAudit } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_support', 'support');
    await seedAdmin(repositories.platformAdmins, 'admin_finance', 'finance');
    const entitlementId = 'ENT-admin-cover-reversal';
    const now = new Date('2026-10-28T12:00:00.000Z');
    await repositories.entitlements.save({
      id: entitlementId,
      orderId: 'ORD-admin-cover-reversal',
      eventId: 'EVT-admin-cover-reversal',
      organizationId: 'ORG-cover-host',
      tierId: 'TIER-cover',
      tierName: 'Cover ticket',
      userId: 'USR-cover-guest',
      currentHolderUserId: 'USR-cover-guest',
      holderName: 'Guest',
      status: 'valid',
      scanCountAllowed: 1,
      scanCount: 0,
      scannedAt: [],
      credentialVersion: 1,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    const account = createEventCoverAccount({
      entitlementId,
      orderId: 'ORD-admin-cover-reversal',
      eventId: 'EVT-admin-cover-reversal',
      guestUserId: 'USR-cover-guest',
      hostOrganizationId: 'ORG-cover-host',
      venueOrganizationId: 'ORG-cover-venue',
      amountPaise: 50_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'cover-v1',
      refundPolicy: 'saved_policy_review',
      activationApproved: true,
      now,
    });
    await repositories.eventCoverAccounts.createIssuedAccount(account);
    await repositories.eventCoverAccounts.reserve(account.id, {
      amountPaise: 10_000,
      operationId: 'cover-operation-1',
      guestConfirmed: true,
      online: true,
      actorUserId: 'venue-operator',
      terminalId: 'venue-terminal',
      receiptReference: 'POS-RECEIPT-1',
      now,
    });
    const capture = await repositories.eventCoverAccounts.capture(
      account.id,
      'cover-operation-1',
      now,
    );
    const authority = new AdminAuthorityService(deps);
    const ops = new AdminOperationsService(deps, authority);

    await expect(
      ops.reverseTicketCoverRedemption(
        'admin_finance',
        entitlementId,
        capture.entry.id,
        'Correct duplicate terminal capture',
      ),
    ).rejects.toThrow(/accounting approval/);
    deps.config.features.m5CoverAccountingApproved = true;
    await expect(
      ops.reverseTicketCoverRedemption(
        'admin_support',
        entitlementId,
        capture.entry.id,
        'Correct duplicate terminal capture',
      ),
    ).rejects.toThrow(ForbiddenError);

    const first = await ops.reverseTicketCoverRedemption(
      'admin_finance',
      entitlementId,
      capture.entry.id,
      'Correct duplicate terminal capture',
    );
    const retry = await ops.reverseTicketCoverRedemption(
      'admin_finance',
      entitlementId,
      capture.entry.id,
      'Correct duplicate terminal capture',
    );
    expect(first).toMatchObject({
      replayed: false,
      account: { remainingPaise: 50_000, redeemedPaise: 0 },
    });
    expect(retry).toMatchObject({ replayed: true, entry: { id: first.entry.id } });
    expect(
      adminAudit.all().filter((record) => record.action === 'EVENT_COVER_REDEMPTION_REVERSE'),
    ).toHaveLength(1);
  });

  it('reconciles event cover accounts as held read-only totals for Admin', async () => {
    const { deps, repositories } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_finance', 'finance');
    const now = new Date('2026-10-28T12:00:00.000Z');
    const first = createEventCoverAccount({
      entitlementId: 'ENT-event-cover-1',
      orderId: 'ORD-event-cover-1',
      eventId: 'EVT-event-cover-aggregate',
      guestUserId: 'USR-cover-guest-1',
      hostOrganizationId: 'ORG-cover-host',
      venueOrganizationId: 'ORG-cover-venue',
      amountPaise: 50_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'cover-v1',
      refundPolicy: 'saved_policy_review',
      activationApproved: true,
      now,
    });
    const second = createEventCoverAccount({
      entitlementId: 'ENT-event-cover-2',
      orderId: 'ORD-event-cover-2',
      eventId: 'EVT-event-cover-aggregate',
      guestUserId: 'USR-cover-guest-2',
      hostOrganizationId: 'ORG-cover-host',
      venueOrganizationId: 'ORG-cover-venue',
      amountPaise: 25_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'cover-v1',
      refundPolicy: 'saved_policy_review',
      activationApproved: true,
      now,
    });
    await repositories.eventCoverAccounts.createIssuedAccount(first);
    await repositories.eventCoverAccounts.createIssuedAccount(second);
    await repositories.eventCoverAccounts.reserve(first.id, {
      amountPaise: 10_000,
      operationId: 'POS-event-cover-1',
      guestConfirmed: true,
      online: true,
      actorUserId: 'USR-venue-operator',
      terminalId: 'TERM-event-cover',
      receiptReference: 'POS-event-cover-1',
      now,
    });
    await repositories.eventCoverAccounts.capture(first.id, 'POS-event-cover-1', now);

    const ops = new AdminOperationsService(deps, new AdminAuthorityService(deps));
    await expect(
      ops.getEventCoverReconciliation('admin_finance', 'EVT-event-cover-aggregate'),
    ).resolves.toMatchObject({
      accountCount: 2,
      scannedAccountCount: 2,
      truncated: false,
      balancedAccountCount: 2,
      unbalancedAccountCount: 0,
      issuedPaise: 75_000,
      remainingPaise: 65_000,
      redeemedPaise: 10_000,
      heldRedemptionPaise: 10_000,
      settlementStatus: 'held',
      settlementEligible: false,
      balanced: true,
    });
  });

  it('restricts email delivery evidence to Admin and never exposes rendered content', async () => {
    const { deps, repositories } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_support', 'support');
    const delivery = {
      id: 'MAIL-safe',
      aggregateId: 'ORD-private',
      kind: 'booking_receipt',
      status: 'sent' as const,
      recipientHash: 'hashed-recipient',
      retryCount: 1,
      providerMessageId: 'provider-request-id',
      createdAt: 1,
      updatedAt: 2,
      sentAt: 2,
      lastError: null,
      leaseExpiresAt: null,
    };
    await deps.emailDeliveries.createIfAbsent(delivery);
    const ops = new AdminOperationsService(deps, new AdminAuthorityService(deps));

    await expect(ops.listEmailDeliveries('guest_1', 'ORD-private')).rejects.toThrow(
      'Platform admin authority required',
    );
    await expect(ops.listEmailDeliveries('admin_support', 'ORD-private')).resolves.toEqual([
      delivery,
    ]);
    expect(JSON.stringify(delivery)).not.toContain('html');
    expect(JSON.stringify(delivery)).not.toContain('recipient@example.test');
  });
});
