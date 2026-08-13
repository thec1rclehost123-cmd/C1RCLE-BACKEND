# Phase 2 — KYC / Onboarding

**Status:** not started · **Depends on:** Phase 0 (auth)

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

## Session Log

(none yet)
