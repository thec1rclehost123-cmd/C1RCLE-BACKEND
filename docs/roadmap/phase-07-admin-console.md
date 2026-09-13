# Phase 7 — Admin console backend

**Status:** Phase A DONE (2026-09-12) · Phase B DONE (2026-09-13) ·
Phase C/D NOT STARTED · Depends on:
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
- [x] Event pause/resume admin override — DONE (2026-09-13). `EVENT_PAUSE`/
      `EVENT_RESUME` added to `AdminAction` as TIER1 (any active admin,
      merely logged — no dual control). New `Event.adminOverride: boolean`
      field (default `false`; any real status transition via
      `transitionEvent` clears it — only `adminPauseEvent` sets it).
      Domain: `adminPauseEvent`/`adminResumeEvent` in `event.ts`, guarded to
      `published`/`sales_paused` only (v1's "cannot pause a completed or
      past event" guard — here it's structural, since the FSM table has no
      other inbound edge to `sales_paused`). Service:
      `AdminOperationsService.{pauseEvent,resumeEvent}`. Route (new file):
      `event-actions.ts` — `POST /admin/events/:eventId/{pause,resume}`.
      Frontend: `apps/admin-console/src/app/events/page.tsx` now has
      working Pause/Resume buttons + an "Admin override" badge. Firestore
      adapter's `toEvent` mapper updated (field-by-field reconstruction,
      defaults `adminOverride: false` for pre-existing docs). Full
      `pnpm check` (backend) + `pnpm turbo run lint typecheck test build
      --concurrency=4` (frontend, 58/58 — the uncapped run OOM'd 3 unrelated
      Next.js build workers, confirmed resource contention not a regression
      by rebuilding each app alone) green.
      **Scope decision:** discovery-weight bounds and featured/spotlight
      curation (also named in this checklist item originally) are deferred
      to Phase D alongside the rest of operator tooling — they're curation
      features with no existing V2 concept to extend (no discovery-weight
      field anywhere in the domain yet), unlike pause/resume which builds
      directly on the existing event FSM. Not an oversight; split out so
      this entry could close on the reused-infrastructure half.
- [x] KYC admin signed-read URLs — DONE (2026-09-13, half-scope, see below).
      `ObjectStoragePort` gained `issueReadUrl`/`ReadUrlRequest`/
      `ReadUrlGrant` (both `EchoObjectStorage` and `FirebaseObjectStorage`
      implement it — v4 signed GET, 10-minute TTL, same pattern as the
      existing upload grant). `OnboardingService.issueDocumentReadUrl`
      (any admin — viewing isn't a decision, unlike approve which stays
      TIER2) resolves the document's `storagePath` from the
      `OnboardingRequest` itself, never from caller input, so no separate
      prefix allowlist is needed the way v1's version had one. Route:
      `GET /admin/onboarding/applications/:requestId/documents/:label/read-url`
      in `onboarding-review.ts`. Frontend: `apps/admin-console/src/app/
      onboarding/page.tsx` now has a Documents column with per-label
      "view" buttons that open the signed URL in a new tab. Full
      `pnpm check` (374 tests) + frontend turbo gate (58/58) green.
      **Scope decision — per-step review state machine NOT built:** v1's
      `deriveKycStatus` rolled multiple per-document statuses into one of
      7 states because v1 had no request-level status at all for KYC
      specifically. V2's `OnboardingRequest.status` (draft/submitted/
      changes_requested/approved/rejected) already serves the same purpose
      at the whole-application grain, and `onboarding-review.ts` already
      ships approve/reject/request-changes on it. Adding a SECOND,
      per-document FSM underneath would duplicate that state rather than
      extend it, for a granularity v2's admin flow has never needed (admins
      review the whole document set at once, not document-by-document).
      Revisit only if/when a real product need for per-document rejection
      shows up — not speculatively.

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
