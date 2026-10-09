import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { createOrganization } from '../../domain/models/organization.js';
import { EchoObjectStorage } from '../../domain/ports/object-storage.js';
import { MemoryPaymentProvider } from '../../domain/ports/payment-provider.js';
import {
  MemoryStaffCredentialProvisioner,
  MemoryStaffRotationStore,
  MemoryStaffUserDirectory,
} from '../../domain/ports/staff-credentials.js';
import { FormatCheckVerificationProvider } from '../../domain/ports/verification.js';
import { MemoryAdminAuditRepository } from '../../infrastructure/memory/memory-audit-repository.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { buildRepositories } from '../../infrastructure/utils.js';
import { noopLogger } from '../../telemetry/logger.js';
import { InventoryService } from '../inventory/inventory-service.js';
import { PricingService } from '../pricing/pricing-service.js';

import { VenueService } from './venue-service.js';

import type { ActorContext, ServiceDeps } from '../context.js';

const NOW = new Date('2026-10-09T10:00:00.000Z');

function createTestDeps(): ServiceDeps {
  const config = createCoreConfig({
    redis: { url: 'redis://localhost:6379' },
    firestore: { projectId: 'test-project' },
    clock: { now: () => NOW },
  });

  const repositories = buildRepositories({
    STORAGE_DRIVER: 'memory',
    FIRESTORE_PROJECT_ID: 'test-project',
  });

  return {
    config,
    logger: noopLogger,
    outbox: new MemoryOutboxStore(),
    adminAudit: new MemoryAdminAuditRepository(),
    verification: new FormatCheckVerificationProvider(),
    objectStorage: new EchoObjectStorage(),
    emailSender: {
      name: 'test',
      sendStaffInvitationEmail: async () => {},
      sendOtpEmail: async () => {},
      sendPasswordResetEmail: async () => {},
      sendOnboardingChangesRequestedEmail: async () => {},
    },
    userDirectory: new MemoryStaffUserDirectory(),
    paymentProvider: new MemoryPaymentProvider('whsec'),
    pricing: new PricingService({ eventCatalog: repositories.catalog }),
    inventory: new InventoryService({
      eventCatalog: repositories.catalog,
      cartReservation: repositories.cartReservations,
      order: repositories.orders,
    }),
    repositories,
    credentialProvisioner: new MemoryStaffCredentialProvisioner(),
    rotationStore: new MemoryStaffRotationStore(),
  };
}

describe('VenueService — auto-provisioning resilience', () => {
  it('automatically provisions a default venue when a venue partner has none', async () => {
    const deps = createTestDeps();
    const service = new VenueService(deps);

    const org = createOrganization({
      id: 'org_venue_1',
      name: 'Club Velvet',
      slug: 'club-velvet',
      capabilities: ['venue'],
      ownerId: 'user_1',
      now: NOW,
    });
    await deps.repositories.organizations.save(org);

    const actor: ActorContext = {
      userId: 'user_1',
      organizationId: 'org_venue_1',
      role: 'owner',
      capabilities: ['venue'],
    };

    const firstList = await service.list(actor, { limit: 10, cursor: null });
    expect(firstList.items.length).toBe(1);
    expect(firstList.items[0]?.public.name).toBe('Club Velvet');
    expect(firstList.items[0]?.organizationId).toBe('org_venue_1');
    expect(firstList.items[0]?.status).toBe('active');

    // Subsequent listing returns the same venue without re-creating
    const secondList = await service.list(actor, { limit: 10, cursor: null });
    expect(secondList.items.length).toBe(1);
    expect(secondList.items[0]?.id).toBe(firstList.items[0]?.id);
  });

  it('provisions a venue when org has venue capability even if actor context capabilities lagged', async () => {
    const deps = createTestDeps();
    const service = new VenueService(deps);

    const org = createOrganization({
      id: 'org_venue_2',
      name: 'Sky Lounge',
      slug: 'sky-lounge',
      capabilities: ['venue'],
      ownerId: 'user_2',
      now: NOW,
    });
    await deps.repositories.organizations.save(org);

    const actorWithoutExplicitCap: ActorContext = {
      userId: 'user_2',
      organizationId: 'org_venue_2',
      role: 'owner',
      capabilities: [],
    };

    const list = await service.list(actorWithoutExplicitCap, { limit: 10, cursor: null });
    expect(list.items.length).toBe(1);
    expect(list.items[0]?.public.name).toBe('Sky Lounge');
  });

  it('does not auto-provision a venue for non-venue organizations', async () => {
    const deps = createTestDeps();
    const service = new VenueService(deps);

    const org = createOrganization({
      id: 'org_host_1',
      name: 'Host Collective',
      slug: 'host-collective',
      capabilities: ['host'],
      ownerId: 'user_3',
      now: NOW,
    });
    await deps.repositories.organizations.save(org);

    const actor: ActorContext = {
      userId: 'user_3',
      organizationId: 'org_host_1',
      role: 'owner',
      capabilities: ['host'],
    };

    const list = await service.list(actor, { limit: 10, cursor: null });
    expect(list.items.length).toBe(0);
  });
});
