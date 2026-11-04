import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createInvitation,
  createOrganization,
  revokeInvitation,
} from '../../domain/models/organization.js';

import { FirestoreInvitationRepository } from './firestore-invitation-repository.js';
import { FirestoreOrganizationRepository } from './firestore-organization-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('invitation recipient and membership transaction (local Emulator)', () => {
  let db: Firestore;
  const refs: FirebaseFirestore.DocumentReference[] = [];
  beforeAll(() => {
    if (!EMULATOR || !/^(127\.0\.0\.1|localhost):\d+$/.test(EMULATOR))
      throw new Error('Requires loopback Firestore Emulator');
    db = new Firestore({ projectId: 'c1rcle-v2', host: EMULATOR, ssl: false });
  });
  afterEach(async () => {
    await Promise.all(refs.splice(0).map((ref) => ref.delete()));
  });
  afterAll(async () => {
    await db.terminate();
  });

  async function fixture() {
    const id = `packet-1-5-${randomUUID()}`;
    const organizations = new FirestoreOrganizationRepository(db);
    const invitations = new FirestoreInvitationRepository(db);
    const org = createOrganization({ id, name: 'Synthetic', slug: id, ownerId: `${id}-owner` });
    await organizations.save(org);
    refs.push(db.collection('v2_organizations').doc(id));
    async function recipient(suffix: string, verified = true) {
      const userId = `${id}-${suffix}`;
      const email = `${userId}@example.invalid`;
      const ref = db.collection('v2_auth_users').doc(userId);
      refs.push(ref);
      await ref.set({ email, emailVerified: verified });
      return { userId, email, ref };
    }
    async function invite(email: string) {
      const invitation = createInvitation({
        id: `packet-1-5-${randomUUID()}`,
        organizationId: id,
        email,
        role: 'manager',
        capabilities: ['host'],
        invitedBy: org.ownerId,
      });
      refs.push(db.collection('v2_organization_invitations').doc(invitation.id));
      await invitations.save(invitation);
      return invitation;
    }
    return { id, org, organizations, invitations, recipient, invite };
  }

  it.each(['wrong-email', 'unverified', 'deleted-account', 'expired', 'revoked'])(
    'leaves both records unchanged for %s',
    async (scenario) => {
      const f = await fixture();
      const user = await f.recipient('recipient', scenario !== 'unverified');
      const invitation = await f.invite(
        scenario === 'wrong-email' ? 'other@example.invalid' : user.email,
      );
      if (scenario === 'deleted-account') await user.ref.delete();
      if (scenario === 'revoked') await f.invitations.save(revokeInvitation(invitation));
      const before = await f.invitations.getById(invitation.id);
      const now = scenario === 'expired' ? new Date(invitation.expiresAt) : new Date();
      await expect(
        f.invitations.acceptForUser(invitation.id, user.userId, () => now),
      ).rejects.toThrow();
      expect(await f.invitations.getById(invitation.id)).toEqual(before);
      expect(await f.organizations.getById(f.id)).toEqual(f.org);
    },
  );

  it('allows only one concurrent consumption and writes memberIds with the membership', async () => {
    const f = await fixture();
    const user = await f.recipient('recipient');
    const invitation = await f.invite(user.email);
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        new FirestoreInvitationRepository(db).acceptForUser(
          invitation.id,
          user.userId,
          () => new Date(),
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await f.invitations.getById(invitation.id)).toMatchObject({
      status: 'accepted',
      acceptedBy: user.userId,
    });
    expect(
      (await f.organizations.getById(f.id))?.members.filter(
        (member) => member.userId === user.userId,
      ),
    ).toHaveLength(1);
    expect(
      (await f.organizations.listForMember(user.userId, { limit: 10 })).items.map((org) => org.id),
    ).toContain(f.id);
  }, 30_000);

  it('preserves concurrent acceptances of separate invitations into the same organization', async () => {
    const f = await fixture();
    const users = await Promise.all([f.recipient('one'), f.recipient('two')]);
    const invites = await Promise.all(users.map((user) => f.invite(user.email)));
    await Promise.all(
      users.map((user, index) =>
        new FirestoreInvitationRepository(db).acceptForUser(
          invites[index]?.id ?? 'missing-invitation',
          user.userId,
          () => new Date(),
        ),
      ),
    );
    expect((await f.organizations.getById(f.id))?.members).toHaveLength(3);
    for (const invitation of invites)
      expect((await f.invitations.getById(invitation.id))?.status).toBe('accepted');
  }, 30_000);

  it('rolls back both writes on an injected transaction abort', async () => {
    const f = await fixture();
    const user = await f.recipient('recipient');
    const invitation = await f.invite(user.email);
    // Inject an abort after both writes have been queued, before commit.
    // This exercises Firestore rollback, not a provider outage simulation.
    const repo = new FirestoreInvitationRepository(db);
    const originalRun = db.runTransaction.bind(db);
    const spy = vi.spyOn(db, 'runTransaction').mockImplementationOnce((update) =>
      originalRun(async (tx) => {
        await update(tx);
        throw new Error('Synthetic commit abort');
      }),
    );
    try {
      await expect(
        repo.acceptForUser(invitation.id, user.userId, () => new Date()),
      ).rejects.toThrow('Synthetic commit abort');
    } finally {
      spy.mockRestore();
    }
    expect(await f.organizations.getById(f.id)).toEqual(f.org);
    expect((await f.invitations.getById(invitation.id))?.status).toBe('pending');
  });
  it('serializes revocation against acceptance without granting revoked access', async () => {
    const f = await fixture();
    const user = await f.recipient('recipient');
    const invitation = await f.invite(user.email);
    const results = await Promise.allSettled([
      f.invitations.acceptForUser(invitation.id, user.userId, () => new Date()),
      f.invitations.save(revokeInvitation(invitation)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const stored = await f.invitations.getById(invitation.id);
    const member = await f.organizations.getMember(f.id, user.userId);
    if (stored?.status === 'accepted') expect(member).toMatchObject({ userId: user.userId });
    else {
      expect(stored?.status).toBe('revoked');
      expect(member).toBeNull();
    }
  }, 30_000);
});
