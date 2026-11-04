import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { createPlatformAdmin } from '../../domain/models/admin-authority.js';
import { EchoObjectStorage } from '../../domain/ports/object-storage.js';
import {
  MemoryStaffCredentialProvisioner,
  MemoryStaffRotationStore,
} from '../../domain/ports/staff-credentials.js';
import { FormatCheckVerificationProvider } from '../../domain/ports/verification.js';
import { MemoryAdminAuditRepository } from '../../infrastructure/memory/memory-audit-repository.js';
import { MemoryEmailDeliveryRepository } from '../../infrastructure/memory/memory-email-delivery-repository.js';
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
  MemoryVenueRepository,
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

  async sendStaffInvitationEmail(): Promise<void> {
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

  async findUserIdByEmail(email: string): Promise<string | null> {
    for (const [id, e] of this.emails) {
      if (e === email) return id;
    }
    return null;
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
    venues: new MemoryVenueRepository(),
  } as unknown as ServiceDeps['repositories'];

  const emailSender = new FakeEmailSender();
  const userDirectory = new FakeUserDirectory();
  const outbox = new MemoryOutboxStore();

  const deps: ServiceDeps = {
    config,
    logger: noopLogger,
    outbox,
    emailDeliveries: new MemoryEmailDeliveryRepository(),
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
    credentialProvisioner: new MemoryStaffCredentialProvisioner(),
    rotationStore: new MemoryStaffRotationStore(),
  };

  const authority = new AdminAuthorityService(deps);
  const service = new OnboardingService(deps, authority);
  return { deps, authority, service, repositories, emailSender, userDirectory, outbox };
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
      storagePath: `kyc/user_a/${created.id}/${label}`,
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

  const invalidPaths = [
    ['another applicant', (id: string) => `kyc/user_b/${id}/id_front`],
    ['another application', () => 'kyc/user_a/other_request/id_front'],
    ['another label', (id: string) => `kyc/user_a/${id}/selfie`],
    ['arbitrary namespace', () => 'private/finance/statement'],
    ['traversal', (id: string) => `kyc/user_a/${id}/../id_front`],
    ['encoded separator', (id: string) => `kyc/user_a/${id}%2Fid_front`],
    ['suffix', (id: string) => `kyc/user_a/${id}/id_front/extra`],
    ['URL', (id: string) => `https://storage.test/kyc/user_a/${id}/id_front`],
  ] as const;

  it.each(invalidPaths)('rejects attaching a path for %s without saving', async (_name, path) => {
    const { service, repositories } = ctx;
    const request = await service.start('user_a', {
      requestedType: 'venue',
      plan: 'basic',
      profile: PROFILE,
    });
    const save = vi.spyOn(repositories.onboarding, 'save');
    await expect(
      service.addDocument('user_a', {
        requestId: request.id,
        label: 'id_front',
        storagePath: path(request.id),
      }),
    ).rejects.toThrow(InvalidOperationError);
    expect(save).not.toHaveBeenCalled();
    expect(await repositories.onboarding.getById(request.id)).toEqual(request);
  });

  it.each(invalidPaths)('refuses signing a persisted path for %s', async (_name, path) => {
    const { service, repositories, deps } = ctx;
    await seedAdmin(repositories, 'admin_a');
    const request = await service.start('user_a', {
      requestedType: 'venue',
      plan: 'basic',
      profile: PROFILE,
    });
    await repositories.onboarding.save({
      ...request,
      documents: [
        {
          label: 'id_front',
          storagePath: path(request.id),
          uploadedAt: NOW.toISOString(),
          status: 'pending',
          reviewedBy: null,
          reviewedAt: null,
          rejectionReason: null,
        },
      ],
    });
    const sign = vi.spyOn(deps.objectStorage, 'issueReadUrl');
    await expect(service.issueDocumentReadUrl('admin_a', request.id, 'id_front')).rejects.toThrow(
      InvalidOperationError,
    );
    expect(sign).not.toHaveBeenCalled();
  });

  it('rejects unknown attachment labels even with a matching path', async () => {
    const { service } = ctx;
    const request = await service.start('user_a', {
      requestedType: 'venue',
      plan: 'basic',
      profile: PROFILE,
    });
    await expect(
      service.addDocument('user_a', {
        requestId: request.id,
        label: 'passport',
        storagePath: `kyc/user_a/${request.id}/passport`,
      }),
    ).rejects.toThrow(InvalidOperationError);
  });

  it('attaches and signs every supported label using its upload grant', async () => {
    const { service, repositories, deps } = ctx;
    await seedAdmin(repositories, 'admin_a');
    const request = await service.start('user_a', {
      requestedType: 'venue',
      plan: 'basic',
      profile: PROFILE,
    });
    const upload = vi.spyOn(deps.objectStorage, 'issueUploadUrl');
    const read = vi.spyOn(deps.objectStorage, 'issueReadUrl');
    for (const label of [
      'id_front',
      'id_back',
      'selfie',
      'registration_certificate',
      'sig_id_front',
      'sig_id_back',
      'sig_selfie',
    ]) {
      const grant = await service.issueDocumentUploadUrl('user_a', {
        requestId: request.id,
        label,
        contentType: 'image/png',
      });
      await service.addDocument('user_a', {
        requestId: request.id,
        label,
        storagePath: grant.storagePath,
      });
      await service.issueDocumentReadUrl('admin_a', request.id, label);
      expect(read).toHaveBeenLastCalledWith({
        key: grant.storagePath,
        expiresAt: expect.any(Number),
      });
      expect(upload.mock.lastCall?.[0].visibility).not.toBe('public');
    }
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

  it('emits authoritative outbox events when a Promoter application is submitted and rejected', async () => {
    const { service, repositories, outbox } = ctx;
    const created = await service.start('user_a', {
      requestedType: 'promoter',
      plan: 'basic',
      profile: PROFILE,
    });
    for (const label of ['id_front', 'id_back', 'selfie']) {
      await service.addDocument('user_a', {
        requestId: created.id,
        label,
        storagePath: `kyc/user_a/${created.id}/${label}`,
      });
    }
    const request = await service.submit('user_a', created.id);
    const submitted = await outbox.listPending();
    expect(submitted.map((row) => row.type)).toContain('promoter.onboarding.submitted');

    await seedAdmin(repositories, 'admin_a');
    await service.reject('admin_a', { requestId: request.id, note: 'Not eligible' });
    const rejected = await outbox.listPending();
    expect(rejected.map((row) => row.type)).toContain('promoter.onboarding.rejected');
    expect(
      rejected.find((row) => row.type === 'promoter.onboarding.rejected')?.payload,
    ).toMatchObject({
      organizationId: 'user_a',
      actorId: 'admin_a',
      payload: { requestId: request.id },
    });
  });

  it('a refused approve() provisions no organization and leaves the request submitted', async () => {
    const { service, repositories } = ctx;
    await seedAdmin(repositories, 'admin_a');
    const request = await submittedRequest(service);

    await expect(service.approve('admin_a', { requestId: request.id })).rejects.toThrow(
      InvalidOperationError,
    );

    expect(await repositories.organizations.listActive(10)).toHaveLength(0);
    expect((await repositories.onboarding.getById(request.id))?.status).toBe('submitted');
  });

  it('blocks approve() when a required document was rejected rather than verified', async () => {
    const { service, repositories } = ctx;
    await seedAdmin(repositories, 'admin_a');
    const request = await submittedRequest(service);
    await service.verifyKycDocument('admin_a', request.id, 'id_front');
    await service.verifyKycDocument('admin_a', request.id, 'id_back');
    await service.rejectKycDocument('admin_a', request.id, 'selfie', 'Blurry');

    await expect(service.approve('admin_a', { requestId: request.id })).rejects.toThrow(
      InvalidOperationError,
    );
  });

  it('404s a read URL for a label that was never uploaded', async () => {
    const { service, repositories } = ctx;
    await seedAdmin(repositories, 'admin_a');
    const request = await submittedRequest(service);

    await expect(service.issueDocumentReadUrl('admin_a', request.id, 'passport')).rejects.toThrow(
      NotFoundError,
    );
  });

  it('mints upload URLs for business-entity labels, and refuses unknown ones', async () => {
    const { service } = ctx;
    const created = await service.start('user_biz', {
      requestedType: 'venue',
      plan: 'basic',
      profile: { ...PROFILE, entityType: 'business' },
    });

    for (const label of ['registration_certificate', 'sig_id_front', 'sig_id_back', 'sig_selfie']) {
      const grant = await service.issueDocumentUploadUrl('user_biz', {
        requestId: created.id,
        label,
        contentType: 'image/png',
      });
      expect(grant.uploadUrl).toEqual(expect.any(String));
    }
    await expect(
      service.issueDocumentUploadUrl('user_biz', {
        requestId: created.id,
        label: 'passport',
        contentType: 'image/png',
      }),
    ).rejects.toThrow(InvalidOperationError);
  });

  it('requestChanges skips the email, still succeeding, when no email is on file', async () => {
    const { service, repositories, emailSender } = ctx;
    await seedAdmin(repositories, 'admin_a');
    const request = await submittedRequest(service);

    const updated = await service.requestChanges('admin_a', {
      requestId: request.id,
      note: 'Selfie is unreadable',
    });
    expect(updated.status).toBe('changes_requested');
    expect(emailSender.sent).toHaveLength(0);
  });
});
