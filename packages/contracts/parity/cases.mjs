import { runGeneratedParityCases } from './cases-generated.mjs';
import { runWireParityCases } from './cases-wire.mjs';

/**
 * ─── Contract parity cases ───────────────────────────────────────────────────
 * The fixtures behind `scripts/contract-parity.mjs`: every case parses one value
 * with the frontend schema and the backend schema and asserts they agree.
 *
 * They live in `packages/contracts` because they ARE contract material — a
 * change to a schema and the case that pins it belong in the same package, so
 * the CI path filter on `packages/contracts/**` covers both and a schema edit
 * cannot ship without its fixtures sitting next to it. The script only loads
 * the two built schema sets and the reporting; it holds no fixtures.
 *
 * Plain ESM (no TypeScript, no build step) so the script can import it directly.
 *
 * @param {object} context
 * @param {(schemaName: string, label: string, value: unknown, expected: boolean) => void} context.agree
 * @param {Record<string, any>} context.frontend         built frontend `@c1rcle/contracts` client
 * @param {Record<string, any>} context.backend          built backend `@c1rcle/contracts` client
 * @param {Record<string, any>} context.frontendErrors   built frontend api-client errors
 * @param {Record<string, any>} context.backendEnvelope  built backend error envelope
 * @param {string} context.zodUrl                        file URL of the zod build both sides share
 * @param {string[]} context.checks                      names of the checks that ran
 * @param {string[]} context.failures                    drift / mistakes found
 */
export async function runParityCases({
  agree,
  frontend,
  backend,
  frontendErrors,
  backendEnvelope,
  zodUrl,
  checks,
  failures,
}) {
  const VALID_USER = {
    id: 'usr_1',
    email: 'partner@example.com',
    displayName: 'Sky Partner',
    role: 'partner',
    avatarUrl: null,
    mustChangePassword: false,
  };

  /* ── role ─────────────────────────────────────────────────────────────────── */
  for (const role of ['guest', 'partner', 'admin']) {
    agree('roleSchema', `accepts ${role}`, role, true);
  }
  agree('roleSchema', 'rejects an unknown role', 'superadmin', false);
  agree('roleSchema', 'rejects a non-string', 3, false);

  /* ── user ─────────────────────────────────────────────────────────────────── */
  agree('userSchema', 'accepts the canonical user', VALID_USER, true);
  agree(
    'userSchema',
    'accepts an https avatar',
    { ...VALID_USER, avatarUrl: 'https://cdn.example.com/a.png' },
    true,
  );
  agree(
    'userSchema',
    'accepts a user still on a temporary staff password',
    { ...VALID_USER, mustChangePassword: true },
    true,
  );
  agree(
    'userSchema',
    'rejects a non-boolean mustChangePassword',
    { ...VALID_USER, mustChangePassword: 'yes' },
    false,
  );
  // Deliberately no "missing mustChangePassword" fixture: the backend requires it
  // while the frontend defaults it to false so it still parses older gateways.
  agree('userSchema', 'rejects a malformed email', { ...VALID_USER, email: 'not-an-email' }, false);
  agree('userSchema', 'rejects a non-url avatar', { ...VALID_USER, avatarUrl: 'nope' }, false);
  agree(
    'userSchema',
    'rejects a missing displayName',
    { ...VALID_USER, displayName: undefined },
    false,
  );
  agree('userSchema', 'rejects an unknown role', { ...VALID_USER, role: 'owner' }, false);

  /* ── session ──────────────────────────────────────────────────────────────── */
  agree(
    'sessionSchema',
    'accepts user + epoch ms',
    { user: VALID_USER, expiresAt: 1_800_000_000_000 },
    true,
  );
  agree(
    'sessionSchema',
    'rejects an ISO string expiry (epoch ms is the contract)',
    { user: VALID_USER, expiresAt: '2026-08-11T00:00:00Z' },
    false,
  );
  agree('sessionSchema', 'rejects a missing user', { expiresAt: 1 }, false);

  /* ── pagination ───────────────────────────────────────────────────────────── */
  const VALID_PAGE_INFO = { page: 1, pageSize: 20, total: 3, hasNextPage: false };
  agree('pageInfoSchema', 'accepts the canonical page info', VALID_PAGE_INFO, true);
  agree(
    'pageInfoSchema',
    'rejects a missing hasNextPage',
    { page: 1, pageSize: 20, total: 3 },
    false,
  );
  agree('pageInfoSchema', 'rejects a string page', { ...VALID_PAGE_INFO, page: '1' }, false);

  /* ── 204 semantics ────────────────────────────────────────────────────────── */
  agree('noContentSchema', 'accepts undefined (204, no body)', undefined, true);
  agree('noContentSchema', 'rejects a body', {}, false);

  /* ── paginated<T> (function, checked separately) ──────────────────────────── */
  {
    const { z } = await import(zodUrl);
    const itemSchema = z.object({ id: z.string() });
    const item = { id: 'x' };
    const frontPaginated = frontend.paginatedSchema(itemSchema);
    const backPaginated = backend.paginatedSchema(itemSchema);
    const good = { items: [item], pageInfo: VALID_PAGE_INFO };
    const bad = { items: [item] };
    for (const [label, value, expected] of [
      ['accepts items + pageInfo', good, true],
      ['rejects a missing pageInfo', bad, false],
    ]) {
      const frontOk = frontPaginated.safeParse(value).success;
      const backOk = backPaginated.safeParse(value).success;
      checks.push(`paginatedSchema: ${label}`);
      if (frontOk !== backOk) {
        failures.push(
          `DRIFT paginatedSchema — "${label}": frontend ${frontOk ? 'accepts' : 'rejects'}, ` +
            `backend ${backOk ? 'accepts' : 'rejects'}`,
        );
      } else if (frontOk !== expected) {
        failures.push(`BOTH WRONG paginatedSchema — "${label}"`);
      }
    }
  }

  /* ── auth bridge ({user, accessToken, expiresAt}) ─────────────────────────── */
  const VALID_AUTH_BRIDGE = {
    user: VALID_USER,
    accessToken: 'session_tok_abcdef',
    expiresAt: 1_800_000_000_000,
  };
  agree(
    'authBridgeResponseSchema',
    'accepts user + token + epoch-ms expiry',
    VALID_AUTH_BRIDGE,
    true,
  );
  agree(
    'authBridgeResponseSchema',
    'accepts another epoch-ms expiry',
    { ...VALID_AUTH_BRIDGE, expiresAt: 1_723_000_000_000 },
    true,
  );
  agree(
    'authBridgeResponseSchema',
    'rejects an ISO-string expiry (epoch ms is the contract)',
    { ...VALID_AUTH_BRIDGE, expiresAt: '2026-08-11T00:00:00Z' },
    false,
  );
  agree(
    'authBridgeResponseSchema',
    'rejects a missing accessToken',
    { user: VALID_USER, expiresAt: 1_800_000_000_000 },
    false,
  );
  agree(
    'authBridgeResponseSchema',
    'rejects an empty accessToken',
    { ...VALID_AUTH_BRIDGE, accessToken: '' },
    false,
  );

  /* ── signup / login requests — both .strict(), neither carries `role` ─────── */
  const VALID_SIGNUP = {
    email: 'partner@example.com',
    password: 'corr3ct-horse',
    displayName: 'Sky Partner',
  };
  agree('signupRequestSchema', 'accepts a well-formed signup', VALID_SIGNUP, true);
  agree(
    'signupRequestSchema',
    'rejects a password under 8 chars',
    { ...VALID_SIGNUP, password: 'short' },
    false,
  );
  agree(
    'signupRequestSchema',
    'rejects an extra `role` key (.strict)',
    { ...VALID_SIGNUP, role: 'admin' },
    false,
  );
  agree(
    'signupRequestSchema',
    'rejects an unknown key (.strict)',
    { ...VALID_SIGNUP, nickname: 'sky' },
    false,
  );

  const VALID_LOGIN = { email: 'partner@example.com', password: 'corr3ct-horse' };
  agree('loginRequestSchema', 'accepts a well-formed login', VALID_LOGIN, true);
  agree('loginRequestSchema', 'rejects an empty password', { ...VALID_LOGIN, password: '' }, false);
  agree(
    'loginRequestSchema',
    'rejects an extra `role` key (.strict)',
    { ...VALID_LOGIN, role: 'admin' },
    false,
  );
  agree(
    'loginRequestSchema',
    'rejects an unknown key (.strict)',
    { ...VALID_LOGIN, remember: true },
    false,
  );

  /* ── password reset (forgot / reset) — anti-oracle ack guard ────────────── */
  const VALID_FORGOT = { email: 'staff@example.com' };
  agree(
    'forgotPasswordRequestSchema',
    'accepts a well-formed forgot-password request',
    VALID_FORGOT,
    true,
  );
  agree('forgotPasswordRequestSchema', 'rejects a missing email', {}, false);
  agree(
    'forgotPasswordRequestSchema',
    'rejects an extra key (.strict)',
    { ...VALID_FORGOT, redirectTo: 'https://app.example.com/reset' },
    false,
  );

  const VALID_RESET = { newPassword: 'corr3ct-horse2', token: 'tok_12345' };
  agree(
    'resetPasswordRequestSchema',
    'accepts a well-formed reset-password request',
    VALID_RESET,
    true,
  );
  agree(
    'resetPasswordRequestSchema',
    'rejects a password under 8 chars',
    { ...VALID_RESET, newPassword: 'short' },
    false,
  );
  agree(
    'resetPasswordRequestSchema',
    'rejects a missing token',
    { newPassword: 'corr3ct-horse2' },
    false,
  );
  agree(
    'resetPasswordRequestSchema',
    'rejects an extra key (.strict)',
    { ...VALID_RESET, sessionId: 's_1' },
    false,
  );

  agree('passwordResetAckSchema', 'accepts the reset ack (status true)', { status: true }, true);
  agree(
    'passwordResetAckSchema',
    'accepts the forgot ack (status true + message)',
    { status: true, message: 'If this email exists in our system, check your email' },
    true,
  );
  agree(
    'passwordResetAckSchema',
    'rejects status false (contract asserts success only)',
    { status: false },
    false,
  );

  /* ── onboarding profile — .strict(), `role` stripped at the boundary ─────── */
  const VALID_ONBOARDING_PROFILE = {
    legalName: 'Neon Room Hospitality LLP',
    contactPerson: 'Asha Menon',
    phone: '+91 22 1234 5678',
    city: 'Mumbai',
  };
  agree('onboardingProfileSchema', 'accepts the required minimum', VALID_ONBOARDING_PROFILE, true);
  agree(
    'onboardingProfileSchema',
    'accepts the optional fields too',
    { ...VALID_ONBOARDING_PROFILE, area: 'Bandra', capacity: 300, instagram: '@neonroom' },
    true,
  );
  agree(
    'onboardingProfileSchema',
    'rejects a `role` key (privilege-escalation guard)',
    { ...VALID_ONBOARDING_PROFILE, role: 'host' },
    false,
  );
  agree(
    'onboardingProfileSchema',
    'rejects an unknown key (.strict)',
    { ...VALID_ONBOARDING_PROFILE, plan: 'basic' },
    false,
  );
  agree(
    'onboardingProfileSchema',
    'rejects a missing required field (city)',
    { legalName: 'X Co', contactPerson: 'Y', phone: '123456' },
    false,
  );

  /* ── onboarding request DTO ──────────────────────────────────────────────── */
  const ISO = '2026-08-27T10:00:00Z';
  const VALID_ONBOARDING_REQUEST = {
    id: 'onb_1',
    userId: 'usr_1',
    status: 'draft',
    requestedType: 'venue',
    plan: 'basic',
    profile: VALID_ONBOARDING_PROFILE,
    documents: [],
    missingDocuments: ['id_front', 'id_back', 'selfie'],
    submittedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    provisionedOrganizationId: null,
    version: 1,
    createdAt: ISO,
    updatedAt: ISO,
  };
  agree(
    'onboardingRequestDtoSchema',
    'accepts a canonical draft request',
    VALID_ONBOARDING_REQUEST,
    true,
  );
  agree(
    'onboardingRequestDtoSchema',
    'rejects a legacy `pending` status (V2 renamed it `submitted`)',
    { ...VALID_ONBOARDING_REQUEST, status: 'pending' },
    false,
  );

  /* ── organization DTO ───────────────────────────────────────────────────── */
  const VALID_ORGANIZATION = {
    id: 'org_1',
    name: 'Neon Room',
    slug: 'neon-room',
    role: 'owner',
    status: 'active',
    version: 1,
    createdAt: ISO,
    updatedAt: ISO,
  };
  agree('organizationDtoSchema', 'accepts a canonical organization', VALID_ORGANIZATION, true);
  agree(
    'organizationDtoSchema',
    'rejects an out-of-enum status',
    { ...VALID_ORGANIZATION, status: 'pending' },
    false,
  );

  /* ── public SEO detail projections ──────────────────────────────────────── */
  const VALID_PUBLIC_VENUE = {
    id: 'ven_1',
    organizationId: 'org_1',
    name: 'Neon Room',
    slug: 'neon-room',
    status: 'active',
    description: 'A public venue description.',
    capacity: 300,
    city: 'Mumbai',
    photoUrl: 'https://images.example.test/venue.webp',
    address: { city: 'Mumbai', state: 'Maharashtra', country: 'IN' },
    facilities: ['stage'],
    version: 1,
    createdAt: ISO,
    updatedAt: ISO,
  };
  agree(
    'venuePublicDetailDtoSchema',
    'accepts authoritative public profile fields',
    VALID_PUBLIC_VENUE,
    true,
  );
  agree(
    'venuePublicDetailDtoSchema',
    'rejects a malformed public photo URL',
    { ...VALID_PUBLIC_VENUE, photoUrl: 'not-a-url' },
    false,
  );

  const VALID_PUBLIC_EVENT_DETAIL = {
    id: 'evt_1',
    organizationId: 'org_1',
    venueId: 'ven_1',
    slug: 'neon-night',
    title: 'Neon Night',
    summary: 'A public event summary.',
    description: '',
    imageUrl: 'https://images.example.test/event.webp',
    startAt: ISO,
    endAt: null,
    status: 'published',
    isPublic: true,
    tags: ['music'],
    startingPricePaise: 5000,
    isFree: false,
    cancellationReason: null,
    compensation: null,
    version: 1,
    createdAt: ISO,
    updatedAt: ISO,
    venue: {
      id: 'ven_1',
      name: 'Neon Room',
      slug: 'neon-room',
      photoUrl: VALID_PUBLIC_VENUE.photoUrl,
      address: VALID_PUBLIC_VENUE.address,
    },
    organizer: { id: 'org_1', name: 'Neon Host', slug: 'neon-host' },
  };
  agree(
    'eventPublicDetailDtoSchema',
    'accepts nullable public venue and organizer projections',
    VALID_PUBLIC_EVENT_DETAIL,
    true,
  );
  agree(
    'eventPublicDetailDtoSchema',
    'rejects an invalid organizer slug',
    { ...VALID_PUBLIC_EVENT_DETAIL, organizer: { id: 'org_1', name: 'Host', slug: 'Bad Slug' } },
    false,
  );

  /* ── partner access DTO — the RBAC source ───────────────────────────────── */
  const VALID_PARTNER_ACCESS = {
    organizationId: 'org_1',
    userId: 'usr_1',
    partnerType: 'venue',
    role: 'owner',
    permissions: ['MANAGE_EVENTS', 'VIEW_ANALYTICS'],
    tabVisibility: null,
  };
  agree(
    'partnerAccessDtoSchema',
    'accepts tabVisibility: null (show every tab)',
    VALID_PARTNER_ACCESS,
    true,
  );
  agree(
    'partnerAccessDtoSchema',
    'accepts an explicit tabVisibility map',
    { ...VALID_PARTNER_ACCESS, tabVisibility: { events: true, finance: false } },
    true,
  );
  agree(
    'partnerAccessDtoSchema',
    'rejects an unknown permission verb',
    { ...VALID_PARTNER_ACCESS, permissions: ['DO_ANYTHING'] },
    false,
  );
  agree(
    'partnerAccessDtoSchema',
    'rejects an unknown partnerType',
    { ...VALID_PARTNER_ACCESS, partnerType: 'admin' },
    false,
  );

  /* ── partnership DTO + venue-share negotiation ────────────────────────────── */
  const VALID_PARTNERSHIP = {
    id: 'partner_1',
    hostOrganizationId: 'org_host',
    venueOrganizationId: 'org_venue',
    venueId: 'venue_1',
    initiatedBy: 'host',
    status: 'active',
    message: null,
    venueShareRate: 20,
    resolutionReason: null,
    resolvedAt: null,
    version: 3,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
  };
  agree(
    'partnershipDtoSchema',
    'accepts an active partnership with a negotiated rate',
    VALID_PARTNERSHIP,
    true,
  );
  agree(
    'partnershipDtoSchema',
    'accepts a partnership with a null venue share (not yet negotiated)',
    { ...VALID_PARTNERSHIP, venueShareRate: null },
    true,
  );
  agree(
    'partnershipDtoSchema',
    'rejects a partnership whose venue share exceeds the 50 cap',
    { ...VALID_PARTNERSHIP, venueShareRate: 51 },
    false,
  );
  agree(
    'partnershipDtoSchema',
    'rejects a fractional venue share',
    { ...VALID_PARTNERSHIP, venueShareRate: 20.5 },
    false,
  );
  agree(
    'requestPartnershipSchema',
    'accepts a request without a proposed rate',
    { venueId: 'venue_1', initiatedBy: 'host' },
    true,
  );
  agree(
    'requestPartnershipSchema',
    'accepts a request with a proposed rate',
    { venueId: 'venue_1', initiatedBy: 'host', venueShareRate: 20 },
    true,
  );
  agree(
    'requestPartnershipSchema',
    'rejects a request with an over-cap proposed rate',
    { venueId: 'venue_1', initiatedBy: 'host', venueShareRate: 51 },
    false,
  );
  agree('setVenueShareRequestSchema', 'accepts a rate', { venueShareRate: 20 }, true);
  agree('setVenueShareRequestSchema', 'accepts clearing the rate', { venueShareRate: null }, true);
  agree('setVenueShareRequestSchema', 'rejects an over-cap rate', { venueShareRate: 51 }, false);
  agree(
    'setVenueShareRequestSchema',
    'rejects a rate outside the schema (450 as landing on garbage)',
    { venueShareRate: 450 },
    false,
  );

  /* ── error envelope: status → code map ────────────────────────────────────── */
  for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 418]) {
    const front = frontendErrors.statusToErrorCode(status);
    const back = backendEnvelope.errorCodeForStatus(status);
    checks.push(`errorCodeForStatus: ${status}`);
    // 4xx outside the mapped set is the one deliberate difference: the frontend
    // collapses it to 'unknown', and so must the backend.
    if (front !== back) {
      failures.push(`DRIFT status→code for ${status}: frontend "${front}", backend "${back}"`);
    }
  }

  /* ── admin role schema ──────────────────────────────────────────────────── */
  const VALID_ADMIN_ROLES = ['super', 'admin', 'ops', 'finance', 'support'];
  for (const role of VALID_ADMIN_ROLES) {
    agree('adminRoleSchema', `accepts admin role "${role}"`, role, true);
  }
  agree('adminRoleSchema', 'rejects V1-only "content" role (dropped in V2)', 'content', false);
  agree('adminRoleSchema', 'rejects V1-only "readonly" role (dropped in V2)', 'readonly', false);
  agree('adminRoleSchema', 'rejects a non-string', 123, false);

  /* ── admin action schema ────────────────────────────────────────────────── */
  const ADMIN_ACTIONS = [
    'EVENT_PAUSE',
    'EVENT_RESUME',
    'ONBOARDING_APPROVE',
    'VENUE_SUSPEND',
    'VENUE_REINSTATE',
    'ORGANIZATION_SUSPEND',
    'ORGANIZATION_REINSTATE',
    'FINANCIAL_REFUND',
    'PAYOUT_BATCH_RUN',
    'DISPUTE_RESOLVE',
    'USER_BAN',
    'USER_UNBAN',
    'ADMIN_PROVISION',
    'ADMIN_ROLE_UPDATE',
    'COMMISSION_ADJUST',
    'PAYOUT_FREEZE',
    'PAYOUT_RELEASE',
    'PROMOTER_SUSPEND',
    'PROMOTER_REINSTATE',
  ];
  for (const action of ADMIN_ACTIONS) {
    agree('adminActionSchema', `accepts action "${action}"`, action, true);
  }
  agree('adminActionSchema', 'rejects an unknown action', 'FORCE_EVENT_COMPLETE', false);
  agree('adminActionSchema', 'rejects a non-string', null, false);

  /* ── admin promoter assignment status schema ────────────────────────────── */
  for (const status of ['active', 'ended', 'suspended']) {
    agree('adminPromoterAssignmentStatusSchema', `accepts status "${status}"`, status, true);
  }
  agree('adminPromoterAssignmentStatusSchema', 'rejects an unknown status', 'pending', false);
  agree('adminPromoterAssignmentStatusSchema', 'rejects a non-string', 123, false);

  /* ── admin promoter assignment DTO shape ────────────────────────────────── */
  const VALID_ADMIN_PROMOTER_ASSIGNMENT = {
    id: 'pmt_0001',
    eventId: 'evt_0001',
    promoterId: 'usr_0001',
    status: 'active',
    ratePercent: 5,
    flatPaise: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    endedAt: null,
    suspendedAt: null,
  };
  agree(
    'adminPromoterAssignmentDtoSchema',
    'accepts a canonical assignment',
    VALID_ADMIN_PROMOTER_ASSIGNMENT,
    true,
  );
  agree(
    'adminPromoterAssignmentDtoSchema',
    'rejects when id is missing',
    { ...VALID_ADMIN_PROMOTER_ASSIGNMENT, id: undefined },
    false,
  );
  agree(
    'adminPromoterAssignmentDtoSchema',
    'rejects when status is invalid',
    { ...VALID_ADMIN_PROMOTER_ASSIGNMENT, status: 'deleted' },
    false,
  );

  /* ── admin promoter action response ─────────────────────────────────────── */
  agree(
    'adminPromoterActionResponseSchema',
    'accepts a valid suspend result',
    {
      promoterId: 'usr_0001',
      action: 'suspended',
      affectedAssignments: 3,
      at: '2026-08-15T00:00:00.000Z',
    },
    true,
  );
  agree(
    'adminPromoterActionResponseSchema',
    'rejects an invalid action',
    {
      promoterId: 'usr_0001',
      action: 'unknown',
      affectedAssignments: 0,
      at: '2026-08-15T00:00:00.000Z',
    },
    false,
  );

  /* ── admin platform settings DTO ─────────────────────────────────────────── */
  const VALID_PLATFORM_SETTINGS = {
    platformFeeRate: 0.15,
    refundSingleApproverThresholdPaise: 50000,
    refundDualApproverThresholdPaise: 500000,
    maintenanceMode: false,
    featureFlags: { enableSpins: true },
    updatedAt: ISO,
  };
  agree('platformSettingsDtoSchema', 'accepts canonical settings', VALID_PLATFORM_SETTINGS, true);
  agree(
    'platformSettingsDtoSchema',
    'accepts maintenance mode + empty flags',
    {
      ...VALID_PLATFORM_SETTINGS,
      maintenanceMode: true,
      featureFlags: {},
    },
    true,
  );
  agree(
    'platformSettingsDtoSchema',
    'rejects fee outside [0,1]',
    { ...VALID_PLATFORM_SETTINGS, platformFeeRate: 1.5 },
    false,
  );
  agree(
    'platformSettingsDtoSchema',
    'rejects a negative threshold',
    { ...VALID_PLATFORM_SETTINGS, refundSingleApproverThresholdPaise: -1 },
    false,
  );
  agree(
    'platformSettingsUpdateRequestSchema',
    'accepts a partial patch',
    {
      refundSingleApproverThresholdPaise: 75000,
    },
    true,
  );
  agree(
    'platformSettingsUpdateRequestSchema',
    'accepts nested featureFlags patch',
    {
      featureFlags: { spins: true, merch: false },
    },
    true,
  );
  agree('platformSettingsUpdateRequestSchema', 'rejects unknown field', { bogus: 1 }, false);

  /* ── admin order DTO ────────────────────────────────────────────────────── */
  const VALID_ADMIN_ORDER = {
    id: 'ord_1',
    eventId: 'evt_1',
    organizationId: 'org_1',
    userId: 'usr_1',
    status: 'paid',
    ticketCount: 2,
    grandTotalPaise: 2000,
    refundedPaise: 0,
    contact: { name: 'Test', email: 't@example.com', phone: '+910000000000' },
    paymentId: 'pay_1',
    paidAt: ISO,
    createdAt: ISO,
  };
  agree('adminOrderDtoSchema', 'accepts a canonical paid order', VALID_ADMIN_ORDER, true);
  agree(
    'adminOrderDtoSchema',
    'accepts nullable userId',
    { ...VALID_ADMIN_ORDER, userId: null },
    true,
  );
  agree(
    'adminOrderDtoSchema',
    'accepts nullable paymentId',
    { ...VALID_ADMIN_ORDER, paymentId: null },
    true,
  );
  agree(
    'adminOrderDtoSchema',
    'rejects an unknown status',
    { ...VALID_ADMIN_ORDER, status: 'in_progress' },
    false,
  );

  /* ── admin venue DTO ────────────────────────────────────────────────────── */
  const VALID_ADMIN_VENUE = {
    id: 'ven_1',
    organizationId: 'org_1',
    name: 'Neon Room',
    slug: 'neon-room',
    city: 'Mumbai',
    status: 'active',
    capacity: 300,
    createdAt: ISO,
    updatedAt: ISO,
  };
  agree('adminVenueDtoSchema', 'accepts a canonical venue', VALID_ADMIN_VENUE, true);
  agree(
    'adminVenueDtoSchema',
    'accepts a suspended venue with null city',
    { ...VALID_ADMIN_VENUE, status: 'suspended', city: null },
    true,
  );
  agree(
    'adminVenueDtoSchema',
    'rejects an out-of-enum status',
    { ...VALID_ADMIN_VENUE, status: 'flagged' },
    false,
  );

  /* ── admin ticket DTO ───────────────────────────────────────────────────── */
  const VALID_ADMIN_TICKET = {
    id: 'ent_1',
    orderId: 'ord_1',
    eventId: 'evt_1',
    organizationId: 'org_1',
    tierName: 'General',
    userId: null,
    holderName: 'Guest',
    status: 'valid',
    scanCountAllowed: 1,
    scanCount: 0,
    lastScannedAt: null,
    createdAt: ISO,
  };
  agree('adminTicketDtoSchema', 'accepts a canonical valid ticket', VALID_ADMIN_TICKET, true);
  agree(
    'adminTicketDtoSchema',
    'accepts a redeemed ticket with a scan timestamp',
    { ...VALID_ADMIN_TICKET, status: 'redeemed', scanCount: 1, lastScannedAt: ISO },
    true,
  );
  agree(
    'adminTicketDtoSchema',
    'rejects an unknown status',
    { ...VALID_ADMIN_TICKET, status: 'used' },
    false,
  );

  /* ── admin promo DTO ────────────────────────────────────────────────────── */
  const VALID_ADMIN_PROMO = {
    id: 'promo_1',
    eventId: 'evt_1',
    organizationId: 'org_1',
    code: 'EARLYBIRD',
    name: 'Early Bird',
    type: 'public',
    discountType: 'percent',
    discountValue: 10,
    maxRedemptions: 100,
    redemptionCount: 5,
    startsAt: null,
    endsAt: null,
    isActive: true,
    createdAt: ISO,
  };
  agree('adminPromoDtoSchema', 'accepts a canonical promo code', VALID_ADMIN_PROMO, true);
  agree(
    'adminPromoDtoSchema',
    'rejects an unknown promo type',
    { ...VALID_ADMIN_PROMO, type: 'unlimited' },
    false,
  );

  /* ── admin dispute status ───────────────────────────────────────────────── */
  agree('adminDisputeStatusSchema', 'accepts "open"', 'open', true);
  agree('adminDisputeStatusSchema', 'accepts "under_review"', 'under_review', true);
  agree('adminDisputeStatusSchema', 'accepts "resolved"', 'resolved', true);
  agree('adminDisputeStatusSchema', 'rejects an unknown status', 'resolved_upheld', false);

  /* ── support ticket status / priority / category enums ─────────────────── */
  for (const status of [
    'open',
    'in_progress',
    'waiting_on_customer',
    'escalated',
    'resolved',
    'closed',
  ]) {
    agree('supportTicketStatusSchema', `accepts status "${status}"`, status, true);
  }
  agree('supportTicketStatusSchema', 'rejects an unknown status', 'snoozed', false);

  for (const priority of ['low', 'medium', 'high', 'urgent']) {
    agree('supportTicketPrioritySchema', `accepts priority "${priority}"`, priority, true);
  }
  agree('supportTicketPrioritySchema', 'rejects an unknown priority', 'critical', false);

  for (const category of ['account', 'billing', 'order', 'event', 'technical', 'other']) {
    agree('supportTicketCategorySchema', `accepts category "${category}"`, category, true);
  }
  agree('supportTicketCategorySchema', 'rejects an unknown category', 'safety', false);

  /* ── support ticket DTO ────────────────────────────────────────────────── */
  const VALID_SUPPORT_TICKET = {
    id: 'tkt_1',
    subject: 'Ticket not delivered',
    description: 'My ticket QR has not arrived in email.',
    category: 'order',
    status: 'open',
    priority: 'medium',
    requester: { userId: 'usr_1', email: 'guest@example.com', organizationId: null },
    assignee: null,
    messages: [],
    internalNotes: [],
    timeline: [],
    links: { venueId: null, eventId: null, orderId: null, organizationId: null, userId: null },
    sla: {
      responseDueAt: ISO,
      resolutionDueAt: ISO,
      responseBreachedAt: null,
      resolutionBreachedAt: null,
    },
    mergedInto: null,
    mergedFrom: [],
    resolvedAt: null,
    resolvedBy: null,
    closedAt: null,
    closedBy: null,
    deletedAt: null,
    deletedBy: null,
    createdAt: ISO,
    updatedAt: ISO,
  };
  agree('supportTicketDtoSchema', 'accepts a canonical open ticket', VALID_SUPPORT_TICKET, true);
  agree(
    'supportTicketDtoSchema',
    'accepts an escalated ticket with an assignee + message',
    {
      ...VALID_SUPPORT_TICKET,
      status: 'escalated',
      assignee: { userId: 'usr_2', name: 'Ops Admin' },
      messages: [
        {
          id: 'msg_1',
          senderRole: 'customer',
          senderId: 'usr_1',
          senderName: 'Guest',
          content: 'Still waiting.',
          createdAt: ISO,
        },
      ],
    },
    true,
  );
  agree(
    'supportTicketDtoSchema',
    'rejects an unknown status',
    { ...VALID_SUPPORT_TICKET, status: 'deleted' },
    false,
  );

  /* ── guest intake command bodies ───────────────────────────────────────── */
  agree(
    'submitSupportTicketSchema',
    'accepts a canonical intake submission',
    {
      subject: 'Broken checkout',
      description: 'Payment failed twice on checkout.',
      category: 'billing',
      priority: 'high',
    },
    true,
  );
  agree(
    'submitSupportTicketSchema',
    'applies the default priority when omitted',
    { subject: 'Help', description: 'How do I transfer my ticket?', category: 'order' },
    true,
  );
  agree(
    'submitSupportTicketSchema',
    'rejects a too-short description',
    { subject: 'Help', description: 'short', category: 'order' },
    false,
  );
  agree(
    'submitSupportTicketSchema',
    'rejects an unknown field',
    { subject: 'Help', description: 'How do I transfer my ticket?', category: 'order', sneaky: 1 },
    false,
  );

  /* ── admin desk command bodies ─────────────────────────────────────────── */
  agree(
    'supportTicketMessageSchema',
    'accepts a message body',
    { content: 'We are on it — checking the QR.' },
    true,
  );
  agree('supportTicketMessageSchema', 'rejects an empty message', { content: '' }, false);
  agree(
    'supportTicketMessageSchema',
    'rejects an unknown field',
    { content: 'ok', to: 'x' },
    false,
  );

  agree(
    'assignSupportTicketSchema',
    'accepts an assignment',
    { userId: 'usr_2', name: 'Ops Admin' },
    true,
  );
  agree('assignSupportTicketSchema', 'rejects a missing name', { userId: 'usr_2' }, false);

  agree(
    'changeSupportTicketPrioritySchema',
    'accepts a priority change',
    { priority: 'urgent' },
    true,
  );
  agree(
    'changeSupportTicketPrioritySchema',
    'rejects an unknown priority',
    { priority: 'severe' },
    false,
  );

  agree('supportTicketLinkSchema', 'accepts an empty link set', {}, true);
  agree(
    'supportTicketLinkSchema',
    'accepts a full link set',
    {
      venueId: 'ven_1',
      eventId: 'evt_1',
      orderId: 'ord_1',
      organizationId: 'org_1',
      userId: 'usr_1',
    },
    true,
  );
  agree(
    'supportTicketLinkSchema',
    'rejects an unknown field',
    { orderId: 'ord_1', bogus: 1 },
    false,
  );

  agree(
    'resolveSupportTicketSchema',
    'accepts a resolve reason',
    { reason: 'Refunded the guest.' },
    true,
  );
  agree('resolveSupportTicketSchema', 'rejects a missing reason', {}, false);

  agree('mergeSupportTicketSchema', 'accepts a merge target', { duplicateTicketId: 'tkt_9' }, true);
  agree('mergeSupportTicketSchema', 'rejects a missing duplicate target', {}, false);

  /* ── door / scanner surface (phase 5) ─────────────────────────────────────── */
  /*
   * The door surface the scanner app consumes. M3 replaced scanner-app's
   * hand-transcribed copy (`apps/scanner-app/src/api/schemas.ts`) with an
   * adapter over `@c1rcle/contracts`, so the app tracks these schemas by
   * construction — these cases pin the door shapes themselves here, keeping the
   * venue-side door/cover-wallet DTOs covered alongside everything else.
   */
  const VALID_DOOR_ENTITLEMENT = {
    id: 'ent_1',
    tierId: 'tier_1',
    tierName: 'General',
    holderName: 'Guest',
    scansUsed: 1,
    scansAllowed: 2,
    status: 'active',
  };

  /* scan outcome (the camera path) */
  agree(
    'scanResponseSchema',
    'accepts a consumed scan with an entitlement',
    { status: 'consumed', checkInId: 'chk_1', entitlement: VALID_DOOR_ENTITLEMENT },
    true,
  );
  agree(
    'scanResponseSchema',
    'accepts a denied scan with a reason',
    { status: 'denied', denyReason: 'already_used', denyMessage: 'Ticket already used' },
    true,
  );
  agree(
    'scanResponseSchema',
    'accepts a couple confirmation with no checkInId',
    {
      status: 'confirmation_required',
      confirmation: { token: 'tok_abcdefghij', expiresAt: ISO, seats: 2 },
    },
    true,
  );
  agree('scanResponseSchema', 'rejects an unknown scan status', { status: 'admitted' }, false);

  /* non-mutating preview — its own valid | invalid vocabulary */
  agree(
    'ticketLookupResponseSchema',
    'accepts a valid preview with an entitlement',
    { status: 'valid', denyReason: null, denyMessage: null, entitlement: VALID_DOOR_ENTITLEMENT },
    true,
  );
  agree(
    'ticketLookupResponseSchema',
    'accepts an invalid preview with a deny reason',
    { status: 'invalid', denyReason: 'expired', denyMessage: 'Ticket expired' },
    true,
  );
  agree(
    'ticketLookupResponseSchema',
    'rejects the check-in `consumed` vocabulary',
    { status: 'consumed', denyReason: null, denyMessage: null },
    false,
  );

  /* door ledger row */
  const VALID_CHECK_IN = {
    id: 'chk_1',
    eventId: 'evt_1',
    status: 'consumed',
    denyReason: null,
    denyMessage: null,
    entitlementId: 'ent_1',
    tierId: 'tier_1',
    tierName: 'General',
    operatorUid: 'usr_1',
    operatorName: 'Ops',
    operatorRole: 'staff',
    gate: 'A',
    deviceId: 'dev_1',
    guestName: 'Guest',
    scannedAt: ISO,
    admittedCount: 1,
    scanCountUsed: 1,
    scanCountAllowed: 2,
    isOffline: false,
    overriddenBy: null,
    overrideReason: null,
    createdAt: ISO,
  };
  agree('checkInDtoSchema', 'accepts a canonical consumed ledger row', VALID_CHECK_IN, true);
  agree(
    'checkInDtoSchema',
    'rejects an unknown ledger status',
    { ...VALID_CHECK_IN, status: 'used' },
    false,
  );

  /* override */
  agree(
    'overrideResponseSchema',
    'accepts an override result',
    {
      checkInId: 'chk_1',
      status: 'overridden',
      overriddenBy: 'usr_1',
      overrideReason: 'Manager approved',
    },
    true,
  );
  agree(
    'overrideResponseSchema',
    'rejects a non-overridden status',
    { checkInId: 'chk_1', status: 'consumed', overriddenBy: 'usr_1', overrideReason: 'x' },
    false,
  );

  /* door stats snapshot */
  const VALID_DOOR_STATS = {
    eventId: 'evt_1',
    occupancy: { inside: 10, capacity: 100, remaining: 90, prebooked: 5, doorEntries: 3 },
    byEntryType: { general: 5 },
    scans: {
      total: 10,
      consumed: 8,
      denied: 1,
      pending: 0,
      revoked: 0,
      overridden: 1,
      expired: 0,
      cancelled: 0,
    },
    doorSales: { count: 2, grossPaise: 2000 },
    coverWallet: {
      activeWallets: 1,
      totalBalancePaise: 5000,
      totalCreditsPaise: 5000,
      totalDebitsPaise: 0,
    },
    generatedAt: ISO,
  };
  agree('doorStatsDtoSchema', 'accepts a canonical door stats snapshot', VALID_DOOR_STATS, true);
  agree(
    'doorStatsDtoSchema',
    'rejects a negative occupancy count',
    { ...VALID_DOOR_STATS, occupancy: { ...VALID_DOOR_STATS.occupancy, inside: -1 } },
    false,
  );

  /* roster */
  const VALID_DOOR_GUEST = {
    id: 'ent_1',
    name: 'Guest',
    ticketType: 'General',
    entryType: 'general',
    quantity: 1,
    source: 'online',
    status: 'entered',
    enteredAt: ISO,
    scansUsed: 1,
    scansAllowed: 1,
  };
  agree('doorGuestSchema', 'accepts a canonical door guest', VALID_DOOR_GUEST, true);
  agree(
    'doorGuestSchema',
    'rejects an unknown guest status',
    { ...VALID_DOOR_GUEST, status: 'used' },
    false,
  );
  agree(
    'doorGuestListResponseSchema',
    'accepts items + truncated',
    { items: [VALID_DOOR_GUEST], truncated: false },
    true,
  );
  agree(
    'doorGuestListResponseSchema',
    'rejects a roster missing the truncated flag',
    { items: [VALID_DOOR_GUEST] },
    false,
  );
  agree(
    'manualCheckInResponseSchema',
    'accepts a manual admission result',
    { guest: VALID_DOOR_GUEST, checkInId: 'chk_1' },
    true,
  );

  /* door sales */
  const VALID_DOOR_SALE = {
    id: 'sale_1',
    eventId: 'evt_1',
    category: 'walkin',
    guestName: 'Guest',
    totalGuests: 2,
    amountPaise: 1000,
    paymentMode: 'cash',
    status: 'active',
    createdAt: ISO,
  };
  agree('doorSaleResponseSchema', 'accepts a canonical door sale', VALID_DOOR_SALE, true);
  agree(
    'doorSaleResponseSchema',
    'rejects an unknown sale category',
    { ...VALID_DOOR_SALE, category: 'takeaway' },
    false,
  );
  agree(
    'doorSalesListResponseSchema',
    'accepts items + pageInfo',
    { items: [VALID_DOOR_SALE], pageInfo: VALID_PAGE_INFO },
    true,
  );
  agree(
    'doorSalesListResponseSchema',
    'rejects a list missing pageInfo',
    { items: [VALID_DOOR_SALE] },
    false,
  );

  /* staff deny body */
  agree(
    'staffDenyBodySchema',
    'accepts a staff deny body',
    { eventId: 'evt_1', reason: 'Guest refused entry' },
    true,
  );
  agree('staffDenyBodySchema', 'rejects a missing reason', { eventId: 'evt_1' }, false);

  /* scanner session + device */
  const VALID_SCANNER_SESSION = {
    id: 'ses_1',
    eventId: 'evt_1',
    codeId: 'code_1',
    sessionToken: 'tok_abcdefghij',
    sessionExpiresAt: ISO,
    deviceId: 'dev_1',
    deviceName: 'Door Phone',
    permissions: { canScan: true, canDoorEntry: true, canWalkIn: true, canCharge: true },
    status: 'active',
    createdAt: ISO,
  };
  agree(
    'scannerSessionDtoSchema',
    'accepts an active scanner session',
    VALID_SCANNER_SESSION,
    true,
  );
  agree(
    'scannerSessionDtoSchema',
    'accepts a revoked session with a null token',
    { ...VALID_SCANNER_SESSION, status: 'revoked', sessionToken: null },
    true,
  );
  agree(
    'scannerSessionDtoSchema',
    'rejects an unknown session status',
    { ...VALID_SCANNER_SESSION, status: 'closed' },
    false,
  );

  const VALID_SCANNER_DEVICE = {
    id: 'dev_row_1',
    deviceId: 'dev_1',
    deviceName: 'Door Phone',
    venueId: 'ven_1',
    status: 'active',
    boundAt: ISO,
    unboundAt: null,
    unboundReason: null,
    lastSeenAt: ISO,
    lastEventId: null,
    lastGate: null,
    scanCount: 0,
    lastScanAt: null,
    lastScanResult: null,
  };
  agree('scannerDeviceDtoSchema', 'accepts a canonical scanner device', VALID_SCANNER_DEVICE, true);
  agree(
    'scannerDeviceDtoSchema',
    'rejects an unknown device status',
    { ...VALID_SCANNER_DEVICE, status: 'retired' },
    false,
  );

  /* door event summary */
  const VALID_DOOR_EVENT = {
    id: 'evt_1',
    title: 'Neon Night',
    slug: 'neon-night',
    venueId: 'ven_1',
    startAt: ISO,
    endAt: null,
    status: 'published',
    capacity: 100,
  };
  agree('doorEventSummarySchema', 'accepts a door event summary', VALID_DOOR_EVENT, true);
  agree(
    'doorEventSummarySchema',
    'accepts a null capacity (unconfigured)',
    { ...VALID_DOOR_EVENT, capacity: null },
    true,
  );
  agree(
    'doorEventSummarySchema',
    'rejects a missing title',
    { ...VALID_DOOR_EVENT, title: undefined },
    false,
  );

  /* start shift — one round trip, must carry the stats snapshot */
  agree(
    'startShiftResponseSchema',
    'accepts a full shift-start payload',
    {
      sessionId: 'ses_1',
      sessionToken: 'tok_abcdefghij',
      sessionExpiresAt: ISO,
      event: VALID_DOOR_EVENT,
      permissions: { canScan: true, canDoorEntry: true, canWalkIn: true, canCharge: true },
      gate: null,
      tiers: [
        { id: 'tier_1', name: 'General', entryType: 'general', pricePaise: 500, available: 100 },
      ],
      stats: VALID_DOOR_STATS,
      device: { deviceId: 'dev_1', deviceName: 'Door Phone' },
    },
    true,
  );
  agree(
    'startShiftResponseSchema',
    'rejects a shift payload missing the stats snapshot',
    {
      sessionId: 'ses_1',
      sessionToken: 'tok_abcdefghij',
      sessionExpiresAt: ISO,
      event: VALID_DOOR_EVENT,
      permissions: { canScan: true, canDoorEntry: true, canWalkIn: true, canCharge: true },
      gate: null,
      tiers: [],
      device: { deviceId: 'dev_1', deviceName: 'Door Phone' },
    },
    false,
  );

  /* couple confirmation body */
  agree(
    'confirmCoupleBodySchema',
    'accepts a couple confirmation body',
    { eventId: 'evt_1', confirmationToken: 'confirmation_token_value', confirmed: true },
    true,
  );
  agree(
    'confirmCoupleBodySchema',
    'rejects a missing confirmed flag',
    { eventId: 'evt_1', confirmationToken: 'confirmation_token_value' },
    false,
  );

  /* paid walk-up ticket sale response */
  agree(
    'doorTicketSaleResponseSchema',
    'accepts a replayed door ticket sale',
    {
      orderId: 'ord_1',
      amountPaise: 1000,
      quantity: 1,
      paymentMode: 'cash',
      ticketIds: ['tkt_1'],
      checkInIds: ['chk_1'],
      replayed: true,
    },
    true,
  );
  agree(
    'doorTicketSaleResponseSchema',
    'rejects a fractional quantity',
    {
      orderId: 'ord_1',
      amountPaise: 1000,
      quantity: 1.5,
      paymentMode: 'cash',
      ticketIds: [],
      checkInIds: [],
      replayed: false,
    },
    false,
  );

  /* cover wallet */
  const VALID_COVER_WALLET = {
    id: 'wal_1',
    eventId: 'evt_1',
    userId: 'usr_1',
    balancePaise: 5000,
    status: 'active',
    openingBalancePaise: 5000,
    totalCreditsPaise: 5000,
    totalDebitsPaise: 0,
    terminatedAt: null,
    createdAt: ISO,
  };
  agree('coverWalletResponseSchema', 'accepts an active cover wallet', VALID_COVER_WALLET, true);
  agree(
    'coverWalletResponseSchema',
    'rejects an unknown wallet status',
    { ...VALID_COVER_WALLET, status: 'paused' },
    false,
  );

  /* ── error codes: the closed union must match exactly ─────────────────────── */
  {
    const FRONTEND_CODES = [
      'network',
      'timeout',
      'aborted',
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'validation',
      'rate_limited',
      'server',
      'parse',
      'unknown',
    ];
    // Backend codes are a type, not a value — probe the builder instead.
    const unreachable = FRONTEND_CODES.filter((code) => {
      const body = backendEnvelope.buildV2ErrorResponse({ status: 400, message: 'x', code });
      return body.code !== code;
    });
    checks.push('ApiErrorCode union');
    if (unreachable.length > 0) {
      failures.push(
        `DRIFT error codes unsupported by the backend envelope: ${unreachable.join(', ')}`,
      );
    }
  }

  /* ── money, tickets, door, sign-in, social (kept in a sibling file) ───────── */
  runWireParityCases({ agree });

  /* ── every other exported schema: differential, generated from the backend ─── */
  runGeneratedParityCases({ frontend, backend, checks, failures });
}
