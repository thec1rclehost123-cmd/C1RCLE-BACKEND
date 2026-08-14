# Phase 2 — KYC / Onboarding

**Status:** substantially done (2026-08-14) · **Depends on:** Phase 0 (auth)

Currently explicitly BLOCKED in every C1RCLE-BACKEND doc
(`docs/reference/frontend-api-map.md`: "no manifest entry exists for KYC/onboarding/
OTP — they are BLOCKED, not planned"). This phase deliberately extends scope
beyond that, per this session's decision to build toward full parity — see
`docs/architecture/decisions.md` D-008.

## What the frontend has (all mocked today, 14 routes)

`apps/partner-dashboard/src/app/api/{auth,kyc}/*` — all hardcoded mock
responses (OTP accepts any 6-digit code, KYC upload returns a stock photo
URL, `create-account` returns a fake `customToken`). These get deleted and
replaced by real backend routes as this phase lands; see
`docs/reference/frontend-api-map.md` §1.1 for the exact route-by-route replacement
table already written.

Onboarding payload shape (from `C1RCLE-FRONTEND/apps/partner-dashboard/src/app/onboard/PageClient.tsx`):
`email, password, phone, name, contactPerson, city, area, website, capacity,
plan, role, association, associatedHostId, instagram, bio,
upcomingEventsText, pastEventsText, businessType, registrationNumber,
entityType, kycStepData`.

## v1 proven logic to port (`thec1rcle`)

- **State machine** on `onboarding_requests`: create-account (seeds
  `users/{uid}` with `role:'pending'`) → onboarding-progress autosave
  (strips `role` from body — privilege-escalation guard, only `onboardingRole`
  stored) → onboard finalize (`role:'onboarding'`, creates
  `onboarding_requests/{id}` with `status:'pending'`) → admin
  approve/reject/request-changes.
- **`adminStore.approveOnboarding(requestId, adminId, adminRole, reason)`** —
  one Firestore transaction: provisions the partner entity by type
  (`venues/{venue_<uid8>}` with `platformFeeRate` by plan:
  `basic→15%, silver→12%, diamond→10%`; `hosts/{host_<uid8>}`;
  `promoters/{promoter_<uid8>}`), sets custom claims, updates user doc,
  creates `partner_memberships/{uid}_{partnerId}`, fires approval email.
  Port the shape (transaction + tiered-authority governance below);
  **do not port the mock Aadhaar check as-is** — it's a structural-checksum
  stub, not a real verification call. Use a pluggable provider interface so a
  real Aadhaar/DigiLocker provider can be swapped in later.
- **Tiered admin authority** (`adminStore.js` — genuinely good pattern, port
  verbatim): TIER1 = single-admin logged; TIER2 (`ONBOARDING_APPROVE`,
  `VENUE_SUSPEND`, `FINANCIAL_REFUND`, `PAYOUT_BATCH_RUN`) = role in
  `[super,admin,ops,finance]`; TIER3 (`ADMIN_PROVISION`, `COMMISSION_ADJUST`,
  `PAYOUT_FREEZE`) = `role==='super'`. High-risk actions use
  propose→resolve dual control (proposer cannot resolve their own proposal).
  Every admin mutation writes an audit record with before/after state.
- Document upload: v1 stored at `kyc/{userId}/{userName}_{docLabel}.{ext}` in
  Firebase Storage. Field→label map: `doc_front→id_front`, `doc_back→id_back`,
  `selfie`, `cheque_doc→cheque`, `sig_doc_front/back`, `reg_doc→registration_certificate`.

## Firestore collections

`v2_onboarding_requests`, `v2_admins`, `v2_admin_audit_logs`,
`v2_proposed_actions`, `v2_verification_attempts` (rate-limit KYC verification
attempts, matches v1's `verificationAttempts/{userId}/attempts/{id}` shape).

## What shipped

**Domain** (`packages/core/src/domain/models/`)
- `onboarding.ts` — FSM `draft → submitted → approved|rejected|changes_requested`,
  with `changes_requested → submitted` so an applicant can fix and resubmit.
  `PLAN_PLATFORM_FEE_PERCENT` (basic 15 / silver 12 / diamond 10, verbatim from
  v1). `REQUIRED_DOCUMENT_LABELS` gate submission. `sanitizeApplicantProfile`
  is v1's `role`-stripping privilege-escalation guard made total: an allow-list,
  so a field added later cannot arrive carrying authority. Re-uploading a label
  replaces it rather than appending, so an admin cannot approve the stale copy.
- `admin-authority.ts` — TIER1/2/3 exactly as v1 defined them, plus
  `PlatformAdmin` and propose→resolve dual control. `resolve` refuses when
  `resolvedBy === proposedBy`.

**Ports** — `OnboardingRepository`, `PlatformAdminRepository`,
`ProposedActionRepository`, `VerificationAttemptRepository`, `AdminAuditRepository`
(before/after, which the existing single-`snapshot` `AuditRecord` cannot express),
and `VerificationProvider`. Memory + Firestore adapters for all of them, both
under the same compare-and-set invariant.

**Application** — `AdminAuthorityService` (resolve → authorize → record; the
proposal desk; `provisionAdminFromProposal` reads its payload from the approved
proposal, never from the executing call) and `OnboardingService` (applicant side
keyed by user id; admin side gated on `ONBOARDING_APPROVE`; approval provisions
the organization with the plan's fee and the single capability applied for).

**Routes** — `/api/v2/onboarding/*` (applicant, not org-scoped) and
`/api/v2/admin/*` (queue, review, proposals, roster, audit). 19 HTTP tests.

## Deferred, and why

- **Signed storage upload.** `addDocument` takes a `storagePath` the client has
  already written to; issuing signed upload URLs needs a Firebase Storage
  bucket decision that has not been made. The label→path convention from v1
  (`kyc/{userId}/{label}.{ext}`) is what the tests use.
- **Approval email.** No mail transport exists in V2 yet; it belongs with
  notifications (Phase 8) rather than bolted onto this path.
- **`v2_verification_attempts` sub-collection shape.** Stored flat with a
  `userId` field rather than v1's `{userId}/attempts/{id}` nesting — a flat
  collection is what `countSince` can aggregate server-side.
_(Bootstrapping the first admin was on this list and is now done — see below.)_

## Bootstrapping the first platform admin

Provisioning an admin through the API is TIER3 under dual control, so the very
first `super` cannot be created through the API at all. Break the cycle once,
from outside:

```
pnpm --filter api-gateway seed:admin -- --user-id <betterAuthUserId> --email <email>
```

`--user-id` must be the **Better Auth user id** of an account that already
exists — admin records are keyed by it, so a typo produces an admin record no
session will ever match. `--role` defaults to `super`.

The script refuses to run on `STORAGE_DRIVER=memory` (it would report success
and change nothing) and refuses when an active admin already exists unless
`--force` is passed. Every seed writes an `ADMIN_SEED` audit record marked as
out-of-band, so it does not read as a normal provisioning in the trail.

## Session Log

### 2026-08-14 — Phase 2 built end to end

- Built everything listed above. Full suite green: 276 tests
  (12 contracts / 165+3 core / 99 gateway), boundaries clean, contract parity
  clean against `C1RCLE-FRONTEND` (33 checks).
- Decisions recorded as D-017 (platform authority ≠ org authority),
  D-018 (the v1 "verification" was a format check and is labelled as one),
  D-019 (platform fee lives outside `OrganizationProps`).
- **`X-User-Id` is now honoured on `STORAGE_DRIVER=memory` only.** The memory
  driver already fabricates the whole actor from a hardcoded `dev-user`, which
  made "applicant A cannot read applicant B's application" and
  admin-vs-applicant untestable at the HTTP layer. On `firestore` the identity
  comes from the verified session and the header is ignored. Called out here
  because it *looks* like an auth bypass in isolation.
- **`Organization` gained `platformFeePercent`.** Firestore documents written
  before today have no such field; the adapter reads them as 15 (the basic
  plan's rate, which is what they were created under).
- Still open: the deferred items above, and Phase 7 will layer the rest of the
  admin console on top of `AdminAuthorityService` — the tiering, dual control
  and audit trail it needs already exist.
