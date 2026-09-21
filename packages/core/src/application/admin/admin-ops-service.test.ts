import { describe, expect, it } from 'vitest';

import { createCoreConfig, type CoreConfig } from '../../config/index.js';
import { ForbiddenError } from '../../domain/errors.js';
import { createPlatformAdmin, type AdminRole } from '../../domain/models/admin-authority.js';
import { createPromoterAssignment } from '../../domain/models/event-catalog.js';
import { EchoObjectStorage } from '../../domain/ports/object-storage.js';
import { MemoryPaymentProvider } from '../../domain/ports/payment-provider.js';
import { FormatCheckVerificationProvider } from '../../domain/ports/verification.js';
import { MemoryAdminAuditRepository } from '../../infrastructure/memory/memory-audit-repository.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { buildRepositories } from '../../infrastructure/utils.js';
import { noopLogger } from '../../telemetry/logger.js';
import { InventoryService } from '../inventory/inventory-service.js';
import { PricingService } from '../pricing/pricing-service.js';

import { AdminAuthorityService } from './admin-authority-service.js';
import { AdminOperationsService } from './admin-ops-service.js';

import type {
  EventCatalogRepository,
  PlatformAdminRepository,
} from '../../domain/ports/repositories.js';
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
      adminAudit,
      verification: new FormatCheckVerificationProvider(),
      objectStorage: new EchoObjectStorage(),
      paymentProvider: new MemoryPaymentProvider('test_webhook_secret'),
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

  it('F1+F2: a support-tier admin cannot suspend or reinstate a promoter', async () => {
    const { deps, repositories } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_support', 'support');
    await seedPromoter(repositories.catalog, 'promoter_1');

    const authority = new AdminAuthorityService(deps);
    const ops = new AdminOperationsService(deps, authority);

    await expect(ops.suspendPromoter('admin_support', 'promoter_1')).rejects.toThrow(
      ForbiddenError,
    );
    await expect(ops.reinstatePromoter('admin_support', 'promoter_1')).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('F1+F2: ops/finance tiers may suspend and reinstate a promoter', async () => {
    const { deps, repositories } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_ops', 'ops');
    await seedPromoter(repositories.catalog, 'promoter_1');

    const authority = new AdminAuthorityService(deps);
    const ops = new AdminOperationsService(deps, authority);

    const result = await ops.suspendPromoter('admin_ops', 'promoter_1');
    expect(result.affected).toBe(1);

    const reinstated = await ops.reinstatePromoter('admin_ops', 'promoter_1');
    expect(reinstated.affected).toBe(1);
  });

  it('F3: suspend/reinstate write exactly one audit record each with before/after', async () => {
    const { deps, repositories, adminAudit } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_ops', 'ops');
    await seedPromoter(repositories.catalog, 'promoter_2', 2);

    const authority = new AdminAuthorityService(deps);
    const ops = new AdminOperationsService(deps, authority);

    await ops.suspendPromoter('admin_ops', 'promoter_2');

    const suspendedRecords = adminAudit
      .all()
      .filter((r) => r.action === 'PROMOTER_SUSPEND' && r.targetId === 'promoter_2');
    expect(suspendedRecords).toHaveLength(1);
    expect(suspendedRecords[0]?.adminId).toBe('admin_ops');
    expect(suspendedRecords[0]?.after).toBeDefined();

    await ops.reinstatePromoter('admin_ops', 'promoter_2');

    const reinstatedRecords = adminAudit
      .all()
      .filter((r) => r.action === 'PROMOTER_REINSTATE' && r.targetId === 'promoter_2');
    expect(reinstatedRecords).toHaveLength(1);
    expect(reinstatedRecords[0]?.before).toBeDefined();
    expect(reinstatedRecords[0]?.after).toBeDefined();
  });

  it('F3: repeat suspend against already-suspended state is a no-op (affected 0, no second audit)', async () => {
    const { deps, repositories, adminAudit } = makeDeps();
    await seedAdmin(repositories.platformAdmins, 'admin_ops', 'ops');
    await seedPromoter(repositories.catalog, 'promoter_3');

    const authority = new AdminAuthorityService(deps);
    const ops = new AdminOperationsService(deps, authority);

    const first = await ops.suspendPromoter('admin_ops', 'promoter_3');
    expect(first.affected).toBe(1);

    const second = await ops.suspendPromoter('admin_ops', 'promoter_3');
    expect(second.affected).toBe(0);

    const records = adminAudit
      .all()
      .filter((r) => r.action === 'PROMOTER_SUSPEND' && r.targetId === 'promoter_3');
    expect(records).toHaveLength(1);
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
});
