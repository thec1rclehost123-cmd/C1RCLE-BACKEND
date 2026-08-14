import { createPlatformAdmin } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole } from '@c1rcle/core/domain';

import { createV2Services } from '../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../test-utils/partner-test-server.js';

import adminRoutes from './admin/onboarding-review.js';
import onboardingRoutes from './onboarding.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Phase 2 HTTP behaviour ──────────────────────────────────────────────────
 *
 * These assert the things that would be *silently* wrong: that an applicant
 * cannot read someone else's application, that a non-admin cannot review one,
 * that `support` cannot approve, that dual control refuses self-approval, and
 * that approval provisions exactly one organization with the plan's fee.
 */

const services = createV2Services();

let server: FastifyInstance;

/** Seeds a platform admin directly — provisioning one is itself TIER3. */
async function seedAdmin(userId: string, role: AdminRole) {
  await services
    .repos()
    .platformAdmins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
}

function asUser(userId: string) {
  return { 'x-user-id': userId, 'idempotency-key': `key-${Math.random().toString(36).slice(2)}` };
}

const FULL_PROFILE = {
  legalName: 'Blue Room Hospitality',
  contactPerson: 'A. Applicant',
  phone: '9876543210',
  city: 'Mumbai',
};

interface ApplicationView {
  id: string;
  status: string;
  missingDocuments: string[];
}

async function startApplication(
  userId: string,
  plan: 'basic' | 'silver' | 'diamond' = 'basic',
): Promise<ApplicationView> {
  const response = await server.inject({
    method: 'POST',
    url: '/onboarding/applications',
    headers: asUser(userId),
    payload: { requestedType: 'venue', plan, profile: FULL_PROFILE },
  });
  expect(response.statusCode).toBe(201);
  return response.json<ApplicationView>();
}

/** Uploads the three labels `submit` requires. */
async function uploadRequiredDocuments(userId: string, requestId: string) {
  for (const label of ['id_front', 'id_back', 'selfie']) {
    const response = await server.inject({
      method: 'POST',
      url: `/onboarding/applications/${requestId}/documents`,
      headers: asUser(userId),
      payload: { label, storagePath: `kyc/${userId}/${label}.jpg` },
    });
    expect(response.statusCode).toBe(200);
  }
}

beforeEach(async () => {
  // The memoized service bundle is shared across suites, so each test starts
  // from an empty store rather than whatever ran before it.
  const repos = services.repos();
  (repos.onboarding as unknown as { requests: Map<string, unknown> }).requests.clear();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.proposals as unknown as { proposals: Map<string, unknown> }).proposals.clear();
  (repos.verificationAttempts as unknown as { attempts: unknown[] }).attempts.length = 0;

  server = await buildPartnerTestServer({ routes: [onboardingRoutes, adminRoutes] });
});

describe('applicant onboarding', () => {
  it('starts an application in draft with every required document missing', async () => {
    const created = await startApplication('user_a');
    expect(created.status).toBe('draft');
    expect(created.missingDocuments).toEqual(['id_front', 'id_back', 'selfie']);
  });

  it('refuses a second live application', async () => {
    await startApplication('user_a');
    const second = await server.inject({
      method: 'POST',
      url: '/onboarding/applications',
      headers: asUser('user_a'),
      payload: { requestedType: 'host', plan: 'basic', profile: FULL_PROFILE },
    });
    expect(second.statusCode).toBe(400);
  });

  it('drops fields that would grant authority from an autosave', async () => {
    const created = await startApplication('user_a');
    const response = await server.inject({
      method: 'PATCH',
      url: `/onboarding/applications/${created.id}`,
      headers: asUser('user_a'),
      // `role` is the exact field v1 stripped as a privilege-escalation guard.
      payload: { city: 'Pune', role: 'admin' },
    });
    // `.strict()` at the boundary rejects it outright — the domain's
    // allow-list is the second line, not the only one.
    expect(response.statusCode).toBe(422);

    const clean = await server.inject({
      method: 'PATCH',
      url: `/onboarding/applications/${created.id}`,
      headers: asUser('user_a'),
      payload: { city: 'Pune' },
    });
    expect(clean.statusCode).toBe(200);
    expect(clean.json().profile.city).toBe('Pune');
  });

  it("reads another applicant's application as not-found, not forbidden", async () => {
    const created = await startApplication('user_a');
    const response = await server.inject({
      method: 'PATCH',
      url: `/onboarding/applications/${created.id}`,
      headers: asUser('user_b'),
      payload: { city: 'Delhi' },
    });
    // A 403 here would confirm the id exists.
    expect(response.statusCode).toBe(404);
  });

  it('refuses to submit until the required documents are present', async () => {
    const created = await startApplication('user_a');
    const early = await server.inject({
      method: 'POST',
      url: `/onboarding/applications/${created.id}/submit`,
      headers: asUser('user_a'),
    });
    expect(early.statusCode).toBe(400);
    expect(early.json().message).toContain('id_front');

    await uploadRequiredDocuments('user_a', created.id);
    const submitted = await server.inject({
      method: 'POST',
      url: `/onboarding/applications/${created.id}/submit`,
      headers: asUser('user_a'),
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().status).toBe('submitted');
  });

  it('reports the format check as a format check, never as verification', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/onboarding/verify-document',
      headers: asUser('user_a'),
      payload: { documentType: 'aadhaar', documentNumber: '234567890123' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.passed).toBe(true);
    expect(body.provider).toBe('format-check');
    expect(body.reason).toBe('format_ok');
  });

  it('bounds verification attempts per applicant', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await server.inject({
        method: 'POST',
        url: '/onboarding/verify-document',
        headers: asUser('user_a'),
        payload: { documentType: 'aadhaar', documentNumber: '111111111111' },
      });
      expect(response.statusCode).toBe(200);
    }
    const sixth = await server.inject({
      method: 'POST',
      url: '/onboarding/verify-document',
      headers: asUser('user_a'),
      payload: { documentType: 'aadhaar', documentNumber: '111111111111' },
    });
    expect(sixth.statusCode).toBe(403);
  });
});

describe('admin review', () => {
  async function submittedApplication(
    plan: 'basic' | 'silver' | 'diamond' = 'basic',
  ): Promise<string> {
    const created = await startApplication('user_a', plan);
    await uploadRequiredDocuments('user_a', created.id);
    await server.inject({
      method: 'POST',
      url: `/onboarding/applications/${created.id}/submit`,
      headers: asUser('user_a'),
    });
    return created.id;
  }

  it('refuses the review queue to a caller who is not a platform admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/onboarding/applications',
      headers: { 'x-user-id': 'user_a' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses approval to an admin below TIER2', async () => {
    const requestId = await submittedApplication();
    await seedAdmin('admin_support', 'support');
    const response = await server.inject({
      method: 'POST',
      url: `/admin/onboarding/applications/${requestId}/approve`,
      headers: asUser('admin_support'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('provisions an organization carrying the plan platform fee', async () => {
    const requestId = await submittedApplication('diamond');
    await seedAdmin('admin_ops', 'ops');

    const response = await server.inject({
      method: 'POST',
      url: `/admin/onboarding/applications/${requestId}/approve`,
      headers: asUser('admin_ops'),
      payload: { note: 'Documents check out' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      request: { status: string; provisionedOrganizationId: string };
      organization: { id: string; ownerId: string; platformFeePercent: number };
    }>();
    expect(body.request.status).toBe('approved');
    expect(body.organization.ownerId).toBe('user_a');
    // diamond → 10%, ported from v1's `approveOnboarding`.
    expect(body.organization.platformFeePercent).toBe(10);
    expect(body.request.provisionedOrganizationId).toBe(body.organization.id);

    const stored = await services.repos().organizations.getById(body.organization.id);
    expect(stored?.members[0]?.capabilities).toEqual(['venue']);
  });

  it('writes a before/after audit record for the approval', async () => {
    const requestId = await submittedApplication();
    await seedAdmin('admin_ops', 'ops');
    await server.inject({
      method: 'POST',
      url: `/admin/onboarding/applications/${requestId}/approve`,
      headers: asUser('admin_ops'),
    });

    const audit = await server.inject({
      method: 'GET',
      url: `/admin/audit?targetId=${requestId}`,
      headers: { 'x-user-id': 'admin_ops' },
    });
    expect(audit.statusCode).toBe(200);
    const { items } = audit.json<{
      items: { action: string; before: unknown; after: unknown }[];
    }>();
    const approval = items.find((record) => record.action === 'ONBOARDING_APPROVE');
    expect(approval?.before).toEqual({ status: 'submitted' });
    expect(approval?.after).toMatchObject({ status: 'approved' });
  });

  it('requires a note when asking for changes', async () => {
    const requestId = await submittedApplication();
    await seedAdmin('admin_ops', 'ops');

    const noNote = await server.inject({
      method: 'POST',
      url: `/admin/onboarding/applications/${requestId}/request-changes`,
      headers: asUser('admin_ops'),
    });
    expect(noNote.statusCode).toBe(400);

    const withNote = await server.inject({
      method: 'POST',
      url: `/admin/onboarding/applications/${requestId}/request-changes`,
      headers: asUser('admin_ops'),
      payload: { note: 'Selfie is unreadable' },
    });
    expect(withNote.statusCode).toBe(200);
    expect(withNote.json().status).toBe('changes_requested');
  });

  it('lets the applicant edit again after changes are requested', async () => {
    const requestId = await submittedApplication();
    await seedAdmin('admin_ops', 'ops');
    await server.inject({
      method: 'POST',
      url: `/admin/onboarding/applications/${requestId}/request-changes`,
      headers: asUser('admin_ops'),
      payload: { note: 'Selfie is unreadable' },
    });

    const edit = await server.inject({
      method: 'PATCH',
      url: `/onboarding/applications/${requestId}`,
      headers: asUser('user_a'),
      payload: { bio: 'Rooftop bar in Bandra' },
    });
    expect(edit.statusCode).toBe(200);
  });
});

describe('dual control', () => {
  async function raiseProvisionProposal(proposer: string) {
    const response = await server.inject({
      method: 'POST',
      url: '/admin/proposals',
      headers: asUser(proposer),
      payload: {
        action: 'ADMIN_PROVISION',
        reason: 'New ops hire',
        payload: { userId: 'user_new_admin', email: 'ops2@c1rcle.test', role: 'ops' },
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id;
  }

  it('refuses to raise a TIER3 proposal from a non-super admin', async () => {
    await seedAdmin('admin_ops', 'ops');
    const response = await server.inject({
      method: 'POST',
      url: '/admin/proposals',
      headers: asUser('admin_ops'),
      payload: { action: 'ADMIN_PROVISION', reason: 'nice try' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a proposal for an action that does not need dual control', async () => {
    await seedAdmin('admin_super', 'super');
    const response = await server.inject({
      method: 'POST',
      url: '/admin/proposals',
      headers: asUser('admin_super'),
      payload: { action: 'ONBOARDING_APPROVE', reason: 'no second signature needed' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses self-approval — the whole point of a second signature', async () => {
    await seedAdmin('admin_super', 'super');
    const proposalId = await raiseProvisionProposal('admin_super');

    const response = await server.inject({
      method: 'POST',
      url: `/admin/proposals/${proposalId}/approve`,
      headers: asUser('admin_super'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses to provision from a proposal nobody has approved', async () => {
    await seedAdmin('admin_super', 'super');
    const proposalId = await raiseProvisionProposal('admin_super');

    const response = await server.inject({
      method: 'POST',
      url: `/admin/proposals/${proposalId}/provision-admin`,
      headers: asUser('admin_super'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('provisions once two different super admins have signed', async () => {
    await seedAdmin('admin_super', 'super');
    await seedAdmin('admin_super2', 'super');
    const proposalId = await raiseProvisionProposal('admin_super');

    const approved = await server.inject({
      method: 'POST',
      url: `/admin/proposals/${proposalId}/approve`,
      headers: asUser('admin_super2'),
      payload: { reason: 'Confirmed with HR' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('approved');

    const provisioned = await server.inject({
      method: 'POST',
      url: `/admin/proposals/${proposalId}/provision-admin`,
      headers: asUser('admin_super2'),
    });
    expect(provisioned.statusCode).toBe(201);
    const body = provisioned.json();
    expect(body).toMatchObject({ id: 'user_new_admin', role: 'ops', isActive: true });
  });

  it('revokes authority without a second signature, and never one’s own', async () => {
    await seedAdmin('admin_super', 'super');
    await seedAdmin('admin_ops', 'ops');

    const ownSelf = await server.inject({
      method: 'POST',
      url: '/admin/admins/admin_super/revoke',
      headers: asUser('admin_super'),
    });
    expect(ownSelf.statusCode).toBe(400);

    const other = await server.inject({
      method: 'POST',
      url: '/admin/admins/admin_ops/revoke',
      headers: asUser('admin_super'),
    });
    expect(other.statusCode).toBe(200);
    expect(other.json().isActive).toBe(false);

    // A revoked admin is refused exactly as a stranger is.
    const afterRevoke = await server.inject({
      method: 'GET',
      url: '/admin/onboarding/applications',
      headers: { 'x-user-id': 'admin_ops' },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });
});
