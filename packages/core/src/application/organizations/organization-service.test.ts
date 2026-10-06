import { describe, expect, it } from 'vitest';

import { createCoreConfig, type CoreConfig } from '../../config/index.js';
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

import { OrganizationService } from './organization-service.js';

import type { EmailSender, StaffInvitationEmail } from '../../domain/ports/email-sender.js';
import type {
  StaffCredentialProvisioner,
  StaffRotationStore,
  StaffUserDirectory,
} from '../../domain/ports/staff-credentials.js';
import type { ActorContext, ServiceDeps } from '../context.js';

class CapturingEmailSender implements EmailSender {
  readonly name = 'capturing';
  sent: StaffInvitationEmail[] = [];
  async sendStaffInvitationEmail(invitation: StaffInvitationEmail): Promise<void> {
    this.sent.push(invitation);
  }
  async sendOtpEmail(): Promise<void> {
    throw new Error('not used in invitation tests');
  }
}

class FailingEmailSender implements EmailSender {
  readonly name = 'failing';
  async sendStaffInvitationEmail(): Promise<void> {
    throw new Error('SMTP down');
  }
  async sendOtpEmail(): Promise<void> {
    throw new Error('not used in invitation tests');
  }
}

class FailingProvisioner extends MemoryStaffCredentialProvisioner {
  override async provisionLogin(): Promise<never> {
    throw new Error('directory down');
  }
}

function makeDeps(
  emailSender: EmailSender,
  partnerDashboardUrl?: string,
  credentialProvisioner?: StaffCredentialProvisioner,
  rotationStore?: StaffRotationStore,
  userDirectory?: StaffUserDirectory,
): ServiceDeps {
  const repositories = buildRepositories({
    STORAGE_DRIVER: 'memory',
    FIRESTORE_PROJECT_ID: 'test-project',
  });
  const config: CoreConfig = createCoreConfig({
    redis: { url: 'redis://localhost:6379' },
    firestore: { projectId: 'test-project' },
    ...(partnerDashboardUrl ? { partnerDashboardUrl } : {}),
  });
  return {
    config,
    logger: noopLogger,
    outbox: new MemoryOutboxStore(),
    adminAudit: new MemoryAdminAuditRepository(),
    verification: new FormatCheckVerificationProvider(),
    objectStorage: new EchoObjectStorage(),
    paymentProvider: new MemoryPaymentProvider('test_webhook_secret'),
    emailSender,
    credentialProvisioner: credentialProvisioner ?? new MemoryStaffCredentialProvisioner(),
    rotationStore: rotationStore ?? new MemoryStaffRotationStore(),
    userDirectory: userDirectory ?? new MemoryStaffUserDirectory(),
    pricing: new PricingService({ eventCatalog: repositories.catalog }),
    inventory: new InventoryService({
      eventCatalog: repositories.catalog,
      cartReservation: repositories.cartReservations,
      order: repositories.orders,
    }),
    repositories,
  };
}

async function seedOrg(
  service: OrganizationService,
): Promise<{ orgId: string; owner: ActorContext }> {
  const bootstrap: ActorContext = {
    userId: 'user_owner',
    organizationId: '',
    role: 'owner',
    capabilities: [],
  };
  const org = await service.create(bootstrap, { name: 'Skyline', slug: 'skyline' });
  const owner: ActorContext = {
    userId: 'user_owner',
    organizationId: org.id,
    role: 'owner',
    capabilities: [],
  };
  return { orgId: org.id, owner };
}

/**
 * ─── Staff-invitation emails ────────────────────────────────────────────────
 * Creating an invitation must also send the invitee an email (Resend in prod,
 * logging without a key). A mail outage must never roll back the invitation
 * itself — the manager still sees it as pending and the invitee can accept
 * from the dashboard.
 */
describe('OrganizationService.createInvitation emails', () => {
  it('sends the invite with an accept link after persisting', async () => {
    const sender = new CapturingEmailSender();
    const deps = makeDeps(sender, 'https://partners.example.com');
    const service = new OrganizationService(deps);
    const { orgId, owner } = await seedOrg(service);

    const invitation = await service.createInvitation(owner, {
      organizationId: orgId,
      email: 'Teammate@Example.com',
      role: 'manager',
      capabilities: ['venue'],
    });

    expect(sender.sent).toHaveLength(1);
    const email = sender.sent[0];
    expect(email?.to).toBe('teammate@example.com');
    expect(email?.orgName).toBe('Skyline');
    expect(email?.role).toBe('manager');
    expect(email?.capabilities).toEqual(['venue']);
    expect(email?.acceptUrl).toBe(
      `https://partners.example.com/invitations/${invitation.id}/accept?email=${encodeURIComponent('teammate@example.com')}`,
    );

    const listed = await service.listInvitations(owner, orgId, { limit: 20, cursor: null });
    expect(listed.items.map((item) => item.id)).toContain(invitation.id);
  });

  it('emails fresh credentials and requires rotation for brand-new addresses', async () => {
    const sender = new CapturingEmailSender();
    const rotationStore = new MemoryStaffRotationStore();
    const provisioner = new MemoryStaffCredentialProvisioner();
    const deps = makeDeps(sender, 'https://partners.example.com', provisioner, rotationStore);
    const service = new OrganizationService(deps);
    const { orgId, owner } = await seedOrg(service);

    await service.createInvitation(owner, {
      organizationId: orgId,
      email: 'newbie@example.com',
      role: 'member',
    });

    const email = sender.sent[0];
    expect(email?.temporaryPassword).toMatch(/^[A-Za-z2-9]{16}$/);
    expect(email?.acceptUrl).toContain(`?email=${encodeURIComponent('newbie@example.com')}`);
    const provision = await provisioner.provisionLogin('newbie@example.com');
    expect(provision.created).toBe(false);
    expect(await rotationStore.isRequired(provision.userId ?? '')).toBe(true);
  });

  it('never touches existing accounts: no credentials, no rotation flag', async () => {
    const sender = new CapturingEmailSender();
    const rotationStore = new MemoryStaffRotationStore();
    const provisioner = new MemoryStaffCredentialProvisioner();
    await provisioner.provisionLogin('veteran@example.com');
    const deps = makeDeps(sender, 'https://partners.example.com', provisioner, rotationStore);
    const service = new OrganizationService(deps);
    const { orgId, owner } = await seedOrg(service);

    await service.createInvitation(owner, {
      organizationId: orgId,
      email: 'veteran@example.com',
      role: 'manager',
    });

    const email = sender.sent[0];
    expect(email?.temporaryPassword).toBeUndefined();
    const provision = await provisioner.provisionLogin('veteran@example.com');
    expect(await rotationStore.isRequired(provision.userId ?? '')).toBe(false);
  });

  it('still creates the invitation when provisioning fails (fail-open)', async () => {
    const sender = new CapturingEmailSender();
    const deps = makeDeps(sender, 'https://partners.example.com', new FailingProvisioner());
    const service = new OrganizationService(deps);
    const { orgId, owner } = await seedOrg(service);

    const invitation = await service.createInvitation(owner, {
      organizationId: orgId,
      email: 'teammate@example.com',
      role: 'member',
    });

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.temporaryPassword).toBeUndefined();
    const listed = await service.listInvitations(owner, orgId, { limit: 20, cursor: null });
    expect(listed.items.map((item) => item.id)).toContain(invitation.id);
  });

  it('still creates the invitation when sending fails (fail-open)', async () => {
    const deps = makeDeps(new FailingEmailSender(), 'https://partners.example.com');
    const service = new OrganizationService(deps);
    const { orgId, owner } = await seedOrg(service);

    const invitation = await service.createInvitation(owner, {
      organizationId: orgId,
      email: 'teammate@example.com',
      role: 'member',
    });

    const listed = await service.listInvitations(owner, orgId, { limit: 20, cursor: null });
    expect(listed.items.map((item) => item.id)).toContain(invitation.id);
  });

  it('rejects a malformed email for the own-invitations read', async () => {
    const deps = makeDeps(new CapturingEmailSender());
    const service = new OrganizationService(deps);

    await expect(service.listMyInvitations('not-an-email')).rejects.toThrow(
      'A valid email address is required',
    );
  });

  it('omits the accept link when no dashboard URL is configured', async () => {
    const sender = new CapturingEmailSender();
    const deps = makeDeps(sender);
    const service = new OrganizationService(deps);
    const { orgId, owner } = await seedOrg(service);

    await service.createInvitation(owner, {
      organizationId: orgId,
      email: 'teammate@example.com',
      role: 'member',
    });

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.acceptUrl).toBeUndefined();
  });

  it('refuses to invite an address that already belongs to a member', async () => {
    const sender = new CapturingEmailSender();
    const userDirectory = new MemoryStaffUserDirectory();
    userDirectory.seed('owner@example.com', 'user_owner');
    const deps = makeDeps(
      sender,
      'https://partners.example.com',
      undefined,
      undefined,
      userDirectory,
    );
    const service = new OrganizationService(deps);
    const { orgId, owner } = await seedOrg(service);

    await expect(
      service.createInvitation(owner, {
        organizationId: orgId,
        email: 'owner@example.com',
        role: 'manager',
      }),
    ).rejects.toThrow('User is already a member of this organization');

    const listed = await service.listInvitations(owner, orgId, { limit: 20, cursor: null });
    expect(listed.items).toHaveLength(0);
    expect(sender.sent).toHaveLength(0);
  });
});
