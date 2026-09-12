# Phase 7 — Admin console backend

**Status:** Phase A DONE (2026-09-12) · Phase B IN PROGRESS · Depends on:
Phase 2 (onboarding approvals), Phase 6 (financial actions)

Living status doc for the admin-console build-out — read this before
starting any module below, another session may have advanced it since you
last looked. Full gap audit + phase plan:
`C:\Users\SHRIYASH SAWANT\.claude\plans\i-ve-ran-the-command-eventual-dewdrop.md`
(local to this machine; if unavailable, this file + route-manifest.ts +
`apps/admin-console/src/lib/admin/admin-api.ts` are ground truth).

`C1RCLE-FRONTEND/apps/admin-console` now has real screens (not an empty
scaffold): onboarding, refunds, payouts, disputes(stub), venues, events,
users, hosts, admins, audit, proposals, overview — all live API calls, no
mocks.

## Phase A — Money correctness — ✅ DONE

Refunds, payout freeze/release/batch, dispute resolution, commission-adjust,
platform-user directory, venue suspend. Routes: `routes/v2/admin/{refunds,
payouts,disputes,organization-actions,directory,venue-actions}.ts`. Verified
via live Firestore-emulator browser click-through (not just unit tests).

## Phase B — Partner/event governance — IN PROGRESS

- [x] Venue reinstate + host/promoter suspend+reinstate — DONE (2026-09-12).
      `VENUE_REINSTATE`, `ORGANIZATION_SUSPEND`, `ORGANIZATION_REINSTATE`
      added to `AdminAction` (all TIER2, direct command — same shape as
      `VENUE_SUSPEND`). Routes: `venue-actions.ts` (`POST
      /admin/venues/:venueId/reinstate`), `organization-actions.ts` (`POST
      /admin/organizations/:organizationId/{suspend,reinstate}`). Domain:
      `reinstateVenue` in `venue.ts`, `suspendOrganization`/
      `reinstateOrganization` in `organization.ts` (both always restore the
      literal `'active'` status — v1's divergent `'reinstated'` string broke
      active-count queries, see `reinstateVenue`'s doc comment). Service:
      `AdminOperationsService.{reinstateVenue,suspendOrganization,
      reinstateOrganization}`. Frontend wired in `apps/admin-console/src/app/
      {venues,hosts}/page.tsx` (suspend/reinstate buttons, real calls, no
      mocks). Full `pnpm check` (backend) + `pnpm turbo run lint typecheck
      test build` (frontend, 58/58) green.
      **Scope decision:** `partnerReprovision` (v1's misclassified-partner
      repair tool) has NO v2 equivalent need — v1 modelled host/venue/
      promoter as separate entity types that a partner could be
      misclassified between; v2 unifies all three into `Organization`
      capabilities on a member, so there is no cross-type repair to do.
      Not building it; flagging here so a future session doesn't treat it
      as an oversight.
- [ ] KYC per-step review state machine + admin signed-read URLs
- [ ] Event platform-override (pause/resume, `adminOverride` flag,
      discovery-weight bounds, featured/spotlight — typed endpoints)

## Phase C — Trust & safety, support — NOT STARTED

User ban + safety reports + content moderation; support ticket desk.

## Phase D — Operator tooling — NOT STARTED

Generic filtered list + audited CSV export with PII redaction; global
entity lookup (omnibox); audit log IP/UA + target-name resolution; admin
invite + role-update flow.

## v1 proven logic to port (`thec1rcle`, `apps/admin-console/lib/server/adminStore.js`)

- Already detailed in Phase 2 (onboarding approvals share this module):
  tiered authority (TIER1/2/3), propose→resolve dual control, mandatory
  before/after-state audit log on every mutation.
- Beyond onboarding: venue suspend, financial refund approval, payout batch
  run, commission adjustment, admin provisioning, partner-type
  reprovisioning (`partnerReprovision()` — deactivates old memberships,
  creates correct entity + membership + claims for a misclassified partner).

## Firestore collections

Shared with Phase 2: `v2_admins`, `v2_admin_audit_logs`, `v2_proposed_actions`.
New: `v2_support_tickets`, `v2_safety_reports`, `v2_platform_announcements`.

## Session Log

(none yet)
