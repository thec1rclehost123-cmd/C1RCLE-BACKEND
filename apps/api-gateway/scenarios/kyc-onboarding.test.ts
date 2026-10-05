import { createPlatformAdmin } from '@c1rcle/core/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { createV2Services } from '../src/lib/v2-services.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── KYC / onboarding end-to-end scenario ────────────────────────────────────
 * Full `buildApp()` stack, memory driver. Walks the applicant wizard
 * (start -> autosave steps -> upload-url -> record document -> submit) for BOTH
 * document vocabularies (individual and business), then the admin KYC desk
 * (verify / reject / request-changes / approve) and proves:
 *   - approve is refused (400) while any required doc is unverified and
 *     provisions NO organization,
 *   - approve after every doc is verified creates the org + membership,
 *   - the applicant then gets a role from `/organizations/:id/access`.
 */

const services = createV2Services();
let server: FastifyInstance;
let seq = 0;

const asUser = (userId: string, orgId?: string) => ({
  'x-user-id': userId,
  ...(orgId ? { 'x-organization-id': orgId } : {}),
  'idempotency-key': `kyc-${++seq}-${Date.now()}`,
});

const PROFILE = {
  legalName: 'Blue Room Hospitality',
  contactPerson: 'A. Applicant',
  phone: '9876543210',
  city: 'Mumbai',
};

const INDIVIDUAL_LABELS = ['id_front', 'id_back', 'selfie'];
const BUSINESS_LABELS = ['registration_certificate', 'sig_id_front', 'sig_id_back', 'sig_selfie'];

const orgCount = () =>
  (services.repos().organizations as unknown as { organizations: Map<string, unknown> })
    .organizations.size;

beforeEach(async () => {
  const repos = services.repos();
  (repos.onboarding as unknown as { requests: Map<string, unknown> }).requests.clear();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.organizations as unknown as { organizations: Map<string, unknown> }).organizations.clear();
  (repos.organizations as unknown as { members: Map<string, unknown> }).members.clear();
  await repos.platformAdmins.save(
    createPlatformAdmin({ id: 'ops_kyc', email: 'ops@c1rcle.test', role: 'ops' }),
  );
  server = await buildApp({});
});

afterEach(async () => {
  await server.close();
});

async function start(userId: string, extraProfile: Record<string, unknown> = {}) {
  const res = await server.inject({
    method: 'POST',
    url: '/api/v2/onboarding/applications',
    headers: asUser(userId),
    payload: { requestedType: 'host', plan: 'basic', profile: { ...PROFILE, ...extraProfile } },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string; missingDocuments: string[]; status: string }>();
}

/** upload-url -> record document, per label (what the wizard does). */
async function uploadDocs(userId: string, requestId: string, labels: string[]) {
  for (const label of labels) {
    const grant = await server.inject({
      method: 'POST',
      url: `/api/v2/onboarding/applications/${requestId}/documents/upload-url`,
      headers: asUser(userId),
      payload: { label, contentType: 'image/jpeg' },
    });
    expect(grant.statusCode, `${label}: ${grant.body}`).toBe(200);
    expect(grant.json().method).toBe('PUT');
    const recorded = await server.inject({
      method: 'POST',
      url: `/api/v2/onboarding/applications/${requestId}/documents`,
      headers: asUser(userId),
      payload: { label, storagePath: grant.json().storagePath },
    });
    expect(recorded.statusCode, `${label}: ${recorded.body}`).toBe(200);
  }
}

const submit = (userId: string, requestId: string) =>
  server.inject({
    method: 'POST',
    url: `/api/v2/onboarding/applications/${requestId}/submit`,
    headers: asUser(userId),
  });

const adminPost = (path: string, payload: object = {}) =>
  server.inject({
    method: 'POST',
    url: `/api/v2/admin/onboarding/applications/${path}`,
    headers: asUser('ops_kyc'),
    payload,
  });

async function runJourney(userId: string, labels: string[], profile: Record<string, unknown>) {
  const app = await start(userId, profile);
  expect(app.status).toBe('draft');
  expect(app.missingDocuments.sort()).toEqual([...labels].sort());

  // Wizard autosave steps (strict: unknown key is a 422).
  const step = await server.inject({
    method: 'PATCH',
    url: `/api/v2/onboarding/applications/${app.id}`,
    headers: asUser(userId),
    payload: { area: 'Bandra', instagram: '@blueroom' },
  });
  expect(step.statusCode, step.body).toBe(200);
  const bad = await server.inject({
    method: 'PATCH',
    url: `/api/v2/onboarding/applications/${app.id}`,
    headers: asUser(userId),
    payload: { role: 'owner' },
  });
  expect(bad.statusCode).toBe(422);

  // Submit before documents is refused.
  expect((await submit(userId, app.id)).statusCode).toBeGreaterThanOrEqual(400);

  await uploadDocs(userId, app.id, labels);
  const submitted = await submit(userId, app.id);
  expect(submitted.statusCode, submitted.body).toBe(200);
  expect(submitted.json().status).toBe('submitted');

  // Approve is refused while unverified, and creates NO org.
  const blocked = await adminPost(`${app.id}/approve`);
  expect(blocked.statusCode, blocked.body).toBe(400);
  expect(orgCount()).toBe(0);

  // Verifying all but one still blocks.
  for (const label of labels.slice(1)) {
    const v = await adminPost(`${app.id}/documents/${label}/verify`);
    expect(v.statusCode, v.body).toBe(200);
  }
  expect((await adminPost(`${app.id}/approve`)).statusCode).toBe(400);
  expect(orgCount()).toBe(0);

  const last = await adminPost(`${app.id}/documents/${labels[0]}/verify`);
  expect(last.statusCode, last.body).toBe(200);

  const approved = await adminPost(`${app.id}/approve`);
  expect(approved.statusCode, approved.body).toBe(200);
  const orgId: string = approved.json().organization.id;
  expect(orgCount()).toBe(1);

  const access = await server.inject({
    method: 'GET',
    url: `/api/v2/organizations/${orgId}/access`,
    headers: { 'x-user-id': userId, 'x-organization-id': orgId },
  });
  expect(access.statusCode, access.body).toBe(200);
  expect(access.json()).toMatchObject({ organizationId: orgId, userId });
  expect(access.json().role).toEqual(expect.any(String));
  expect(access.json().permissions.length).toBeGreaterThan(0);

  // Tenant header must equal the path org (membership itself is only resolved
  // by real auth on the firestore driver; the memory driver fabricates actors).
  const crossTenant = await server.inject({
    method: 'GET',
    url: `/api/v2/organizations/${orgId}/access`,
    headers: { 'x-user-id': userId, 'x-organization-id': 'org_someone_else' },
  });
  expect(crossTenant.statusCode, crossTenant.body).toBe(403);
  return { orgId, requestId: app.id };
}

describe('scenario: KYC onboarding', () => {
  it('individual applicant: wizard -> verified KYC -> org + role', async () => {
    await runJourney('indiv_1', INDIVIDUAL_LABELS, {});
  });

  it('business applicant: business labels gate approval, then org + role', async () => {
    await runJourney('biz_1', BUSINESS_LABELS, {
      entityType: 'business',
      registrationNumber: 'U12345MH2020PTC000001',
    });
  });

  it('business application cannot be submitted with only the individual labels', async () => {
    const app = await start('biz_2', { entityType: 'business' });
    await uploadDocs('biz_2', app.id, INDIVIDUAL_LABELS);
    const res = await submit('biz_2', app.id);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('rejected document keeps approval blocked; request-changes reopens editing', async () => {
    const app = await start('indiv_2');
    await uploadDocs('indiv_2', app.id, INDIVIDUAL_LABELS);
    expect((await submit('indiv_2', app.id)).statusCode).toBe(200);

    for (const label of ['id_front', 'id_back']) {
      expect((await adminPost(`${app.id}/documents/${label}/verify`)).statusCode).toBe(200);
    }
    const noReason = await adminPost(`${app.id}/documents/selfie/reject`, {});
    expect(noReason.statusCode).toBe(422);
    const rejected = await adminPost(`${app.id}/documents/selfie/reject`, {
      reason: 'Selfie is blurry',
    });
    expect(rejected.statusCode, rejected.body).toBe(200);

    expect((await adminPost(`${app.id}/approve`)).statusCode).toBe(400);
    expect(orgCount()).toBe(0);

    // Request-changes needs a note, then flips status and lets the applicant edit.
    expect((await adminPost(`${app.id}/request-changes`)).statusCode).toBe(400);
    const changes = await adminPost(`${app.id}/request-changes`, { note: 'Re-upload selfie' });
    expect(changes.statusCode, changes.body).toBe(200);
    expect(changes.json().status).toBe('changes_requested');

    const edit = await server.inject({
      method: 'PATCH',
      url: `/api/v2/onboarding/applications/${app.id}`,
      headers: asUser('indiv_2'),
      payload: { bio: 'Rooftop bar in Bandra' },
    });
    expect(edit.statusCode, edit.body).toBe(200);

    // Re-upload the bad document, resubmit, verify it, approve.
    await uploadDocs('indiv_2', app.id, ['selfie']);
    const resubmit = await submit('indiv_2', app.id);
    expect(resubmit.statusCode, resubmit.body).toBe(200);
    expect((await adminPost(`${app.id}/documents/selfie/verify`)).statusCode).toBe(200);
    const approved = await adminPost(`${app.id}/approve`);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(orgCount()).toBe(1);
  });

  it('KYC desk and approval are admin-only', async () => {
    const app = await start('indiv_3');
    await uploadDocs('indiv_3', app.id, INDIVIDUAL_LABELS);
    await submit('indiv_3', app.id);
    for (const path of [
      `${app.id}/documents/selfie/verify`,
      `${app.id}/approve`,
      `${app.id}/request-changes`,
    ]) {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v2/admin/onboarding/applications/${path}`,
        headers: asUser('indiv_3'),
        payload: { note: 'x' },
      });
      expect([401, 403], `${path}: ${res.body}`).toContain(res.statusCode);
    }
    expect(orgCount()).toBe(0);
  });
});
