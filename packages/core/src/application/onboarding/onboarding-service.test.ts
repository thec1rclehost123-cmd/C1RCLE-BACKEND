import { beforeEach, describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { InvalidOperationError } from '../../domain/errors.js';
import { createPlatformAdmin } from '../../domain/models/admin-authority.js';
import { EchoObjectStorage } from '../../domain/ports/object-storage.js';
import { FormatCheckVerificationProvider } from '../../domain/ports/verification.js';
import { MemoryAdminAuditRepository } from '../../infrastructure/memory/memory-audit-repository.js';
import {
  MemoryOnboardingRepository,
  MemoryPlatformAdminRepository,
  MemoryProposedActionRepository,
  MemoryVerificationAttemptRepository,
} from '../../infrastructure/memory/memory-onboarding-repository.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import {
  MemoryCartReservationRepository,
  MemoryEntitlementRepository,
  MemoryEventCatalogRepository,
  MemoryOrderRepository,
  MemoryOrganizationRepository,
} from '../../infrastructure/memory/memory-repositories.js';
import { noopLogger } from '../../telemetry/logger.js';
import { AdminAuthorityService } from '../admin/admin-authority-service.js';
import { InventoryService } from '../inventory/inventory-service.js';
import { PricingService } from '../pricing/pricing-service.js';

import { OnboardingService } from './onboarding-service.js';

import type {
  EmailSender,
  OnboardingChangesRequestedEmailParams,
} from '../../domain/ports/email-sender.js';
import type { UserDirectoryPort } from '../../domain/ports/user-directory.js';
import type { ServiceDeps } from '../context.js';

/**
 * ─── OnboardingService — KYC document desk + approve gate ────────────────────
 * Service-layer coverage over the memory driver: document verify/reject,
 * the approve() gate on `allRequiredDocumentsVerified`, and requestChanges()'s
 * best-effort email notification (must never fail the review it is attached
 * to).
 */

const NOW = new Date('2026-09-01T10:00:00.000Z');

class FakeEmailSender implements EmailSender {
  readonly name = 'fake';
  sent: { recipient: string; params: OnboardingChangesRequestedEmailParams }[] = [];
  shouldThrow = false;

  async sendOtpEmail(): Promise<void> {
    // unused by these tests
  }

  async sendPasswordResetEmail(): Promise<void> {
    // unused by these tests
  }

  async sendOnboardingChangesRequestedEmail(
    recipient: string,
    params: OnboardingChangesRequestedEmailParams,
  ): Promise<void> {
    if (this.shouldThrow) throw new Error('provider outage');
    this.sent.push({ recipient, params });
  }
}

class FakeUserDirectory implements UserDirectoryPort {
  readonly name = 'fake';
  emails = new Map<string, string>();

  async getEmailById(userId: string): Promise<string | null> {
    return this.emails.get(userId) ?? null;
  }
}

function buildDeps() {
  const config = createCoreConfig({
    redis: { url: 'redis://localhost:6379' },
    firestore: { projectId: 'test-project' },
    clock: { now: () => NOW },
  });

  const repositories = {
    organizations: new MemoryOrganizationRepository(),
    onboarding: new MemoryOnboardingRepository(),
    platformAdmins: new MemoryPlatformAdminRepository(),
    proposals: new MemoryProposedActionRepository(),
    verificationAttempts: new MemoryVerificationAttemptRepository(),
    catalog: new MemoryEventCatalogRepository(),
    cartReservations: new MemoryCartReservationRepository(),
    orders: new MemoryOrderRepository(),
    entitlements: new MemoryEntitlementRepository(),
  } as unknown as ServiceDeps['repositories'];

  const emailSender = new FakeEmailSender();
  const userDirectory = new FakeUserDirectory();

  const deps: ServiceDeps = {
    config,
    logger: noopLogger,
    outbox: new MemoryOutboxStore(),
    adminAudit: new MemoryAdminAuditRepository(),
    verification: new FormatCheckVerificationProvider(),
    objectStorage: new EchoObjectStorage(),
    emailSender,
    userDirectory,
    paymentProvider: {} as ServiceDeps['paymentProvider'],
    pricing: new PricingService({ eventCatalog: repositories.catalog }),
    inventory: new InventoryService({
      eventCatalog: repositories.catalog,
      cartReservation: repositories.cartReservations,
      order: repositories.orders,
    }),
    repositories,
  };

  const authority = new AdminAuthorityService(deps);
  const service = new OnboardingService(deps, authority);
  return { deps, authority, service, repositories, emailSender, userDirectory };
}

const PROFILE = {
  legalName: 'Blue Room Hospitality',
  contactPerson: 'A. Applicant',
  phone: '9876543210',
  city: 'Mumbai',
};

async function submittedRequest(service: OnboardingService) {
  const created = await service.start('user_a', {
    requestedType: 'venue',
    plan: 'basic',
    profile: PROFILE,
  });
  for (const label of ['id_front', 'id_back', 'selfie']) {
    await service.addDocument('user_a', {
      requestId: created.id,
      label,
      storagePath: `kyc/${label}.jpg`,
    });
  }
  return service.submit('user_a', created.id);
}

async function seedAdmin(repositories: ServiceDeps['repositories'], id: string) {
  await repositories.platformAdmins.save(
    createPlatformAdmin({ id, email: `${id}@c1rcle.test`, role: 'ops', now: NOW }),
  );
}

describe('OnboardingService — KYC document desk', () => {
  let ctx: ReturnType<typeof buildDeps>;

  beforeEach(() => {
    ctx = buildDeps();
  });

  it('verifies a document', async () => {
    const { service, repositories } = ctx;
    await seedAdmin(repositories, 'admin_a');
    const request = await submittedRequest(service);

    const updated = await service.verifyKycDocument('admin_a', request.id, 'id_front');
    expect(updated.documents.find((d) => d.label === 'id_front')).toMatchObject({
      status: 'verified',
      reviewedBy: 'admin_a',
    });
  });

  it('rejects a document with a reason', async () => {
    const { service, repositories } = ctx;
    await seedAdmin(repositories, 'admin_a');
    const request = await submittedRequest(service);

    const updated = await service.rejectKycDocument('admin_a', request.id, 'selfie', 'Blurry');
    expect(updated.documents.find((d) => d.label === 'selfie')).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Blurry',
    });
  });

  it('refuses to review an unknown label', async () => {
    const { service, repositories } = ctx;
    await seedAdmin(repositories, 'admin_a');
    const request = await submittedRequest(service);

    await expect(service.verifyKycDocument('admin_a', request.id, 'passport')).rejects.toThrow(
      InvalidOperationError,
    );
  });

  it('refuses to reject without a reason', async () => {
    const { service, repositories } = ctx;
    await seedAdmin(repositories, 'admin_a');
    const request = await submittedRequest(service);

    await expect(service.rejectKycDocument('admin_a', request.id, 'selfie', '')).rejects.toThrow(
      InvalidOperationError,
    );
  });

  it('blocks approve() until every required document is verified', async () => {
    const { service, repositories } = ctx;
    await seedAdmin(repositories, 'admin_a');
    const request = await submittedRequest(service);

    await service.verifyKycDocument('admin_a', request.id, 'id_front');
    await service.verifyKycDocument('admin_a', request.id, 'id_back');
    // selfie left unverified

    await expect(service.approve('admin_a', { requestId: request.id })).rejects.toThrow(
      InvalidOperationError,
    );
  });

  it('allows approve() once all required documents are verified', async () => {
    const { service, repositories } = ctx;
    await seedAdmin(repositories, 'admin_a');
    const request = await submittedRequest(service);

    for (const label of ['id_front', 'id_back', 'selfie']) {
      await service.verifyKycDocument('admin_a', request.id, label);
    }

    const { request: approved } = await service.approve('admin_a', { requestId: request.id });
    expect(approved.status).toBe('approved');
  });

  it('mints a document read URL for any active admin', async () => {
    const { service, repositories } = ctx;
    await seedAdmin(repositories, 'admin_a');
    const request = await submittedRequest(service);

    const grant = await service.issueDocumentReadUrl('admin_a', request.id, 'id_front');
    expect(grant.readUrl).toEqual(expect.any(String));
  });

  it('requestChanges still succeeds and is audited even when the email sender throws', async () => {
    const { service, repositories, emailSender, userDirectory } = ctx;
    await seedAdmin(repositories, 'admin_a');
    const request = await submittedRequest(service);
    userDirectory.emails.set('user_a', 'applicant@example.com');
    emailSender.shouldThrow = true;

    const updated = await service.requestChanges('admin_a', {
      requestId: request.id,
      note: 'Selfie is unreadable',
    });
    expect(updated.status).toBe('changes_requested');
    expect(emailSender.sent).toHaveLength(0);
  });

  it('requestChanges sends the notification when an email is on file', async () => {
    const { service, repositories, emailSender, userDirectory } = ctx;
    await seedAdmin(repositories, 'admin_a');
    const request = await submittedRequest(service);
    userDirectory.emails.set('user_a', 'applicant@example.com');

    await service.requestChanges('admin_a', {
      requestId: request.id,
      note: 'Selfie is unreadable',
    });
    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0]).toMatchObject({
      recipient: 'applicant@example.com',
      params: { legalName: 'Blue Room Hospitality', note: 'Selfie is unreadable' },
    });
  });
});
