import { describe, expect, it } from 'vitest';

import { createCoreConfig, type CoreConfig } from '../../config/index.js';
import { ForbiddenError, InvalidOperationError } from '../../domain/errors.js';
import { createInvitation } from '../../domain/models/organization.js';
import { EchoObjectStorage } from '../../domain/ports/object-storage.js';
import { MemoryPaymentProvider } from '../../domain/ports/payment-provider.js';
import {
  MemoryStaffCredentialProvisioner,
  MemoryStaffRotationStore,
  MemoryStaffUserDirectory,
  TEMPORARY_PASSWORD_TTL_MS,
  generateTemporaryPassword,
} from '../../domain/ports/staff-credentials.js';
import { FormatCheckVerificationProvider } from '../../domain/ports/verification.js';
import { MemoryAdminAuditRepository } from '../../infrastructure/memory/memory-audit-repository.js';
import { MemoryEmailDeliveryRepository } from '../../infrastructure/memory/memory-email-delivery-repository.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { type MemoryUserAccountRepository } from '../../infrastructure/memory/memory-user-account-repository.js';
import { buildRepositories } from '../../infrastructure/utils.js';
import { noopLogger } from '../../telemetry/logger.js';
import { InventoryService } from '../inventory/inventory-service.js';
import { PricingService } from '../pricing/pricing-service.js';

import { OrganizationService } from './organization-service.js';

import type { EmailSender, StaffInvitationEmail } from '../../domain/ports/email-sender.js';
import type {
  StaffCredentialProvisioner,
  StaffRotationStore,
} from '../../domain/ports/staff-credentials.js';
import type { UserDirectoryPort } from '../../domain/ports/user-directory.js';
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
  async sendPasswordResetEmail(): Promise<void> {
    throw new Error('not used in invitation tests');
  }
  async sendOnboardingChangesRequestedEmail(): Promise<void> {
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
  async sendPasswordResetEmail(): Promise<void> {
    throw new Error('not used in invitation tests');
  }
  async sendOnboardingChangesRequestedEmail(): Promise<void> {
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
  userDirectory?: UserDirectoryPort,
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
    emailDeliveries: new MemoryEmailDeliveryRepository(),
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
    expect(email?.temporaryPassword).toMatch(/^[A-Za-z2-9]{8}$/);
    // Valid for exactly two days, recorded with the rotation flag.
    const issuedAt =
      Date.parse(email?.temporaryPasswordExpiresAt ?? '') - TEMPORARY_PASSWORD_TTL_MS;
    expect(Math.abs(issuedAt - Date.now())).toBeLessThan(5_000);
    expect(email?.acceptUrl).toContain(`?email=${encodeURIComponent('newbie@example.com')}`);
    const provision = await provisioner.provisionLogin('newbie@example.com');
    expect(provision.created).toBe(false);
    expect(provision.temporaryPassword).toBeNull();
    expect(provisioner.getPassword(provision.userId ?? '')).toBe(email?.temporaryPassword);
    expect(await rotationStore.isRequired(provision.userId ?? '')).toBe(true);
  });

  it('preserves existing credentials and does not require rotation when inviting an existing account', async () => {
    const sender = new CapturingEmailSender();
    const rotationStore = new MemoryStaffRotationStore();
    const provisioner = new MemoryStaffCredentialProvisioner();
    const original = await provisioner.provisionLogin('veteran@example.com');
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
    expect(provisioner.getPassword(original.userId ?? '')).toBe(original.temporaryPassword);
    expect(await rotationStore.isRequired(original.userId ?? '')).toBe(false);
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

  it('revokes an invitation without changing the recipient account or rotation state', async () => {
    const provisioner = new MemoryStaffCredentialProvisioner();
    const rotation = new MemoryStaffRotationStore();
    const original = await provisioner.provisionLogin('existing@example.invalid');
    if (!original.userId) throw new Error('Expected account');
    await rotation.setRequired(original.userId, true);
    const deps = makeDeps(
      new CapturingEmailSender(),
      'https://partners.example.com',
      provisioner,
      rotation,
      provisioner.directory,
    );
    const service = new OrganizationService(deps);
    const { orgId, owner } = await seedOrg(service);
    const invitation = await service.createInvitation(owner, {
      organizationId: orgId,
      email: 'existing@example.invalid',
      role: 'member',
    });
    expect((await service.revokeInvitation(owner, invitation.id)).status).toBe('revoked');
    expect(await provisioner.directory.findUserIdByEmail('existing@example.invalid')).toBe(
      original.userId,
    );
    expect(provisioner.getPassword(original.userId)).toBe(original.temporaryPassword);
    expect(await rotation.isRequired(original.userId)).toBe(true);
  });

  it('removes membership without deleting credentials or resetting them on re-invite', async () => {
    const sender = new CapturingEmailSender();
    const rotationStore = new MemoryStaffRotationStore();
    const provisioner = new MemoryStaffCredentialProvisioner();
    const userDirectory = provisioner.directory;
    const deps = makeDeps(
      sender,
      'https://partners.example.com',
      provisioner,
      rotationStore,
      userDirectory,
    );
    const service = new OrganizationService(deps);
    const { orgId, owner } = await seedOrg(service);

    // 1. Invite and accept
    const invite = await service.createInvitation(owner, {
      organizationId: orgId,
      email: 'staff@example.com',
      role: 'member',
    });
    const provisionedId = await userDirectory.findUserIdByEmail('staff@example.com');
    expect(provisionedId).not.toBeNull();
    if (!provisionedId) throw new Error('Expected provisionedId');
    const initialPassword = provisioner.getPassword(provisionedId);
    expect(initialPassword).toBeTruthy();

    (deps.repositories.users as MemoryUserAccountRepository).save({
      id: provisionedId,
      email: 'staff@example.com',
      emailVerified: true,
      name: 'Synthetic staff',
      image: null,
      role: 'partner',
      createdAt: 0,
      updatedAt: 0,
    });
    await service.acceptInvitation(
      { ...owner, userId: provisionedId },
      {
        invitationId: invite.id,
        userId: provisionedId,
      },
    );

    // 2. Remove member (revoke access)
    await service.removeMember(owner, orgId, provisionedId);

    // Organization access is revoked; account security state remains intact.
    expect(provisioner.getPassword(provisionedId)).toBe(initialPassword);
    expect(await userDirectory.findUserIdByEmail('staff@example.com')).toBe(provisionedId);
    expect(await rotationStore.isRequired(provisionedId)).toBe(true);
    expect(
      (await deps.repositories.organizations.getById(orgId))?.members.some(
        (member) => member.userId === provisionedId,
      ),
    ).toBe(false);

    // Revoked invite must exist in invitations
    const invitations = await service.listInvitations(owner, orgId, { limit: 20, cursor: null });
    const revoked = invitations.items.find((i) => i.email === 'staff@example.com');
    expect(revoked).toBeDefined();
    expect(revoked?.status).toBe('revoked');

    // 3. Re-invite ("Add again")
    sender.sent.length = 0;
    const reInvite = await service.createInvitation(owner, {
      organizationId: orgId,
      email: 'staff@example.com',
      role: 'manager',
    });

    expect(reInvite.status).toBe('pending');
    expect(sender.sent).toHaveLength(1);
    const newEmail = sender.sent[0];
    expect(newEmail?.temporaryPassword).toBeUndefined();
    expect(provisioner.getPassword(provisionedId)).toBe(initialPassword);

    const newUserId = await userDirectory.findUserIdByEmail('staff@example.com');
    expect(newUserId).toBe(provisionedId);
    if (!newUserId) throw new Error('Expected newUserId');
    expect(await rotationStore.isRequired(newUserId)).toBe(true);
  });
});

describe('invitation recipient binding and atomic acceptance', () => {
  async function fixture() {
    const deps = makeDeps(new CapturingEmailSender());
    const service = new OrganizationService(deps);
    const { orgId, owner } = await seedOrg(service);
    const users = deps.repositories.users as MemoryUserAccountRepository;
    function account(id: string, email: string, emailVerified = true) {
      users.save({
        id,
        email,
        emailVerified,
        name: 'Synthetic',
        image: null,
        role: 'partner',
        createdAt: 0,
        updatedAt: 0,
      });
      return { ...owner, userId: id, organizationId: '' };
    }
    async function invite(id: string, email: string) {
      const invitation = createInvitation({
        id,
        organizationId: orgId,
        email,
        role: 'manager',
        invitedBy: owner.userId,
      });
      await deps.repositories.invitations.save(invitation);
      return invitation;
    }
    return { deps, service, orgId, owner, account, invite };
  }
  it.each(['wrong-email', 'unverified', 'missing', 'forged-user-id'])(
    'refuses %s without consuming the invitation or adding membership',
    async (scenario) => {
      const f = await fixture();
      const actor = f.account(
        'recipient',
        scenario === 'wrong-email' ? 'other@example.invalid' : 'invitee@example.invalid',
        scenario !== 'unverified',
      );
      if (scenario === 'missing')
        (f.deps.repositories.users as MemoryUserAccountRepository).users.delete(actor.userId);
      const invitation = await f.invite('binding', 'invitee@example.invalid');
      await expect(
        f.service.acceptInvitation(actor, {
          invitationId: invitation.id,
          userId: scenario === 'forged-user-id' ? f.owner.userId : actor.userId,
        }),
      ).rejects.toThrow();
      expect((await f.deps.repositories.invitations.getById(invitation.id))?.status).toBe(
        'pending',
      );
      expect((await f.deps.repositories.organizations.getById(f.orgId))?.members).toHaveLength(1);
    },
  );
  it('accepts a normalized verified recipient and preserves both concurrent memberships', async () => {
    const f = await fixture();
    const actors = [
      f.account('one', 'ONE@example.invalid'),
      f.account('two', 'two@example.invalid'),
    ];
    const invitations = await Promise.all([
      f.invite('one-invite', 'one@example.invalid'),
      f.invite('two-invite', 'two@example.invalid'),
    ]);
    await Promise.all(
      actors.map((actor, index) =>
        f.service.acceptInvitation(actor, {
          invitationId: invitations[index]?.id ?? 'missing-invitation',
          userId: actor.userId,
        }),
      ),
    );
    expect(
      (await f.deps.repositories.organizations.getById(f.orgId))?.members
        .map((member) => member.userId)
        .sort(),
    ).toEqual(['one', 'two', f.owner.userId].sort());
    for (const actor of actors)
      expect(
        await f.deps.repositories.organizations.getMember(f.orgId, actor.userId),
      ).toMatchObject({ userId: actor.userId, role: 'manager' });
    for (const invitation of invitations)
      expect((await f.deps.repositories.invitations.getById(invitation.id))?.status).toBe(
        'accepted',
      );
  });
  it('consumes a matching existing member invitation without changing role or organization version', async () => {
    const f = await fixture();
    const actor = f.account(f.owner.userId, 'owner@example.invalid');
    const invitation = await f.invite('existing-member', 'owner@example.invalid');
    const before = await f.deps.repositories.organizations.getById(f.orgId);
    await f.service.acceptInvitation(actor, { invitationId: invitation.id, userId: actor.userId });
    expect(await f.deps.repositories.organizations.getById(f.orgId)).toEqual(before);
    expect((await f.deps.repositories.invitations.getById(invitation.id))?.acceptedBy).toBe(
      actor.userId,
    );
    await expect(
      f.service.acceptInvitation(actor, { invitationId: invitation.id, userId: actor.userId }),
    ).rejects.toThrow('accepted');
    expect((await f.deps.repositories.organizations.getMember(f.orgId, actor.userId))?.role).toBe(
      'owner',
    );
  });
});

/**
 * ─── Temporary password: 8 characters, valid two days ───────────────────────
 */
describe('temporary staff password', () => {
  it('is 8 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateTemporaryPassword()).toMatch(/^[A-HJ-NP-Za-km-z2-9]{8}$/);
    }
  });

  it('stops working after two days and works right up to then', async () => {
    const sender = new CapturingEmailSender();
    const rotationStore = new MemoryStaffRotationStore();
    const provisioner = new MemoryStaffCredentialProvisioner();
    const service = new OrganizationService(
      makeDeps(sender, 'https://partners.example.com', provisioner, rotationStore),
    );
    const { orgId, owner } = await seedOrg(service);
    await service.createInvitation(owner, {
      organizationId: orgId,
      email: 'gate1@example.com',
      role: 'gate_staff',
    });
    const userId = (await provisioner.directory.findUserIdByEmail('gate1@example.com')) ?? '';
    const hours = (h: number) => new Date(Date.now() + h * 3_600_000);
    expect(await rotationStore.isExpired(userId, hours(47))).toBe(false);
    expect(await rotationStore.isExpired(userId, hours(49))).toBe(true);
    // Rotating the password clears both the flag and the expiry.
    await rotationStore.setRequired(userId, false);
    expect(await rotationStore.isExpired(userId, hours(500))).toBe(false);
  });

  it('never expires an account that was not issued an expiry (legacy flags)', async () => {
    const rotationStore = new MemoryStaffRotationStore();
    await rotationStore.setRequired('legacy', true);
    expect(await rotationStore.isExpired('legacy', new Date(Date.now() + 900 * 86_400_000))).toBe(
      false,
    );
  });
});

/**
 * ─── Role ladder: authority only flows downward ─────────────────────────────
 * owner > admin (ops lead) > manager (venue manager) > door_supervisor >
 * gate_staff. You can grant, change, remove, revoke and resend only for roles
 * strictly below your own.
 */
describe('role hierarchy', () => {
  async function setup() {
    const sender = new CapturingEmailSender();
    const rotationStore = new MemoryStaffRotationStore();
    const provisioner = new MemoryStaffCredentialProvisioner();
    const service = new OrganizationService(
      makeDeps(sender, 'https://partners.example.com', provisioner, rotationStore),
    );
    const { orgId, owner } = await seedOrg(service);
    const as = (userId: string, role: ActorContext['role']): ActorContext => ({
      userId,
      organizationId: orgId,
      role,
      capabilities: [],
    });
    for (const [userId, role] of [
      ['u_ops', 'admin'],
      ['u_mgr', 'manager'],
      ['u_mgr2', 'manager'],
      ['u_sup', 'door_supervisor'],
      ['u_gate', 'gate_staff'],
    ] as const) {
      await service.inviteMember(owner, { organizationId: orgId, userId, role });
    }
    return { service, orgId, owner, as, sender, rotationStore, provisioner };
  }

  it('lets a venue manager invite gate staff and door supervisors only', async () => {
    const { service, orgId, as } = await setup();
    const manager = as('u_mgr', 'manager');
    for (const role of ['gate_staff', 'door_supervisor'] as const) {
      await expect(
        service.createInvitation(manager, {
          organizationId: orgId,
          email: `${role}@example.com`,
          role,
        }),
      ).resolves.toMatchObject({ role });
    }
    for (const role of ['manager', 'admin'] as const) {
      await expect(
        service.createInvitation(manager, {
          organizationId: orgId,
          email: `${role}@example.com`,
          role,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it('gives the ops lead authority over managers but not over another ops lead or the owner', async () => {
    const { service, orgId, as } = await setup();
    const ops = as('u_ops', 'admin');
    await expect(
      service.createInvitation(ops, {
        organizationId: orgId,
        email: 'm@example.com',
        role: 'manager',
      }),
    ).resolves.toMatchObject({ role: 'manager' });
    await expect(
      service.createInvitation(ops, {
        organizationId: orgId,
        email: 'a@example.com',
        role: 'admin',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.removeMember(ops, orgId, 'user_owner')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('gives door supervisors and gate staff no power over anyone', async () => {
    const { service, orgId, as } = await setup();
    for (const actor of [as('u_sup', 'door_supervisor'), as('u_gate', 'gate_staff')]) {
      await expect(
        service.createInvitation(actor, {
          organizationId: orgId,
          email: 'x@example.com',
          role: 'gate_staff',
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(service.changeRole(actor, orgId, 'u_gate', 'member')).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
  });

  it('only changes roles strictly below the actor, and only to roles below the actor', async () => {
    const { service, orgId, as } = await setup();
    const manager = as('u_mgr', 'manager');
    // Down the ladder is fine.
    await expect(
      service.changeRole(manager, orgId, 'u_gate', 'door_supervisor'),
    ).resolves.toBeDefined();
    await expect(service.changeRole(manager, orgId, 'u_sup', 'gate_staff')).resolves.toBeDefined();
    // Cannot promote anyone to your own level or above.
    await expect(service.changeRole(manager, orgId, 'u_sup', 'manager')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(service.changeRole(manager, orgId, 'u_sup', 'admin')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // Cannot touch a peer or a superior.
    await expect(service.changeRole(manager, orgId, 'u_mgr2', 'gate_staff')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(service.changeRole(manager, orgId, 'u_ops', 'gate_staff')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // Nobody changes their own role.
    await expect(service.changeRole(manager, orgId, 'u_mgr', 'gate_staff')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('only removes people strictly below the actor; anyone may leave themselves', async () => {
    const { service, orgId, as } = await setup();
    const manager = as('u_mgr', 'manager');
    await expect(service.removeMember(manager, orgId, 'u_mgr2')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(service.removeMember(manager, orgId, 'u_ops')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(service.removeMember(manager, orgId, 'u_gate')).resolves.toBeDefined();
    const supervisor = as('u_sup', 'door_supervisor');
    await expect(service.removeMember(supervisor, orgId, 'u_sup')).resolves.toBeDefined();
  });

  it('only revokes invitations for roles below the actor', async () => {
    const { service, orgId, owner, as } = await setup();
    const manager = as('u_mgr', 'manager');
    const managerInvite = await service.createInvitation(owner, {
      organizationId: orgId,
      email: 'newmgr@example.com',
      role: 'manager',
    });
    const gateInvite = await service.createInvitation(manager, {
      organizationId: orgId,
      email: 'newgate@example.com',
      role: 'gate_staff',
    });
    await expect(service.revokeInvitation(manager, managerInvite.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(service.revokeInvitation(manager, gateInvite.id)).resolves.toMatchObject({
      status: 'revoked',
    });
  });
});

/**
 * ─── Resend: a lapsed temporary password is replaced, never a live one ──────
 */
describe('resendInvitation', () => {
  async function setup() {
    const sender = new CapturingEmailSender();
    const rotationStore = new MemoryStaffRotationStore();
    const provisioner = new MemoryStaffCredentialProvisioner();
    const service = new OrganizationService(
      makeDeps(
        sender,
        'https://partners.example.com',
        provisioner,
        rotationStore,
        provisioner.directory,
      ),
    );
    const { orgId, owner } = await seedOrg(service);
    const manager: ActorContext = {
      userId: 'u_mgr',
      organizationId: orgId,
      role: 'manager',
      capabilities: [],
    };
    await service.inviteMember(owner, { organizationId: orgId, userId: 'u_mgr', role: 'manager' });
    return { service, orgId, owner, manager, sender, rotationStore, provisioner };
  }

  it('issues a new 2-day password when the first one was never rotated', async () => {
    const { service, orgId, manager, sender, rotationStore, provisioner } = await setup();
    const invitation = await service.createInvitation(manager, {
      organizationId: orgId,
      email: 'cashier@example.com',
      role: 'gate_staff',
    });
    const first = sender.sent[0]?.temporaryPassword;
    const userId = (await provisioner.directory.findUserIdByEmail('cashier@example.com')) ?? '';
    expect(provisioner.getPassword(userId)).toBe(first);

    await service.resendInvitation(manager, invitation.id);

    const second = sender.sent[1]?.temporaryPassword;
    expect(second).toMatch(/^[A-Za-z2-9]{8}$/);
    expect(second).not.toBe(first);
    expect(provisioner.getPassword(userId)).toBe(second);
    expect(sender.sent[1]?.acceptUrl).toContain(invitation.id);
    expect(sender.sent[1]?.temporaryPasswordExpiresAt).toBeDefined();
    expect(await rotationStore.isRequired(userId)).toBe(true);
    expect(await rotationStore.isExpired(userId, new Date(Date.now() + 47 * 3_600_000))).toBe(
      false,
    );
  });

  it('never replaces the password of someone who already chose their own', async () => {
    const { service, orgId, manager, sender, rotationStore, provisioner } = await setup();
    const invitation = await service.createInvitation(manager, {
      organizationId: orgId,
      email: 'active@example.com',
      role: 'gate_staff',
    });
    const userId = (await provisioner.directory.findUserIdByEmail('active@example.com')) ?? '';
    const chosen = provisioner.getPassword(userId);
    await rotationStore.setRequired(userId, false); // they rotated

    await service.resendInvitation(manager, invitation.id);

    expect(sender.sent[1]?.temporaryPassword).toBeUndefined();
    expect(sender.sent[1]?.acceptUrl).toBeDefined();
    expect(provisioner.getPassword(userId)).toBe(chosen);
  });

  it('refuses non-pending invitations and invitations for equal or higher roles', async () => {
    const { service, orgId, owner, manager } = await setup();
    const higher = await service.createInvitation(owner, {
      organizationId: orgId,
      email: 'boss@example.com',
      role: 'admin',
    });
    await expect(service.resendInvitation(manager, higher.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const gate = await service.createInvitation(manager, {
      organizationId: orgId,
      email: 'gate@example.com',
      role: 'gate_staff',
    });
    await service.revokeInvitation(manager, gate.id);
    await expect(service.resendInvitation(manager, gate.id)).rejects.toBeInstanceOf(
      InvalidOperationError,
    );
  });
});
