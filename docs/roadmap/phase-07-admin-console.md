# Phase 7 — Admin console backend

**Status:** Phase A DONE (2026-09-12) · Phase B DONE (2026-09-13) ·
Phase C PAUSED (user ban done 2026-09-13; safety-reports/support-desk
deferred, no intake path exists — see below) · Phase D DONE except
admin invite-by-email (deferred, API surface verified 2026-09-20 —
see below) · Depends on:
Phase 2 (onboarding approvals), Phase 6 (financial actions)

Living status doc for the admin-console build-out — read this before
starting any module below, another session may have advanced it since you
last looked. Full gap audit + phase plan:
`C:\Users\SHRIYASH SAWANT\.claude\plans\i-ve-ran-the-command-eventual-dewdrop.md`
(local to this machine; if unavailable, this file + route-manifest.ts +
`apps/admin-console/src/lib/admin/admin-api.ts` are ground truth).

`C1RCLE-FRONTEND/apps/admin-console` now has real screens (not an empty
scaffold): onboarding, orders, refunds, payouts, disputes, venues, events,
users, hosts, admins, audit, proposals, overview — all live API calls, no
mocks.

> **Remaining-work backlog:** see `ADMIN-DASHBOARD-GAPS.md` (V1→V2 parity
> gap audit + execution batches). Deferred items and decisions below are
> mirrored there.

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

## Phase C — Trust & safety, support — IN PROGRESS

- [x] User ban/unban — DONE (2026-09-13). `USER_BAN`/`USER_UNBAN` added to
      `AdminAction` (TIER2, direct command — matches v1's
      `setUserBanStatus`). New domain model `UserBan` (own aggregate/
      collection `v2_user_bans`), NOT a field on `PlatformUser` —
      `UserAccountRepository` is read-only by design (never mutates the
      Better Auth `v2_auth_users` collection), so ban state lives
      separately and is joined onto the directory read at query time.
      `UserAccountRepository` gained a `getById` (previously list-only) so
      the ban/unban response can assemble a real user view without an
      O(n) directory scan. Domain: `banUser`/`unbanUser` in `user-ban.ts`
      (nulls `bannedAt`/`bannedBy`/`banReason` on unban, matching v1's
      exact field-clearing behavior). Service:
      `AdminOperationsService.{banUser,unbanUser}`, and `listUsers` now
      joins ban status onto each page. Route (new file): `user-actions.ts`
      — `POST /admin/users/:userId/{ban,unban}`. Frontend:
      `apps/admin-console/src/app/users/page.tsx` now has ban (with a
      required-feeling reason field, confirm step) / unban buttons and an
      Active/Banned status badge. Full `pnpm check` (379 tests) + frontend
      turbo gate (58/58) green.
- [ ] Safety reports + content moderation (soft-delete pattern) — PAUSED.
      Both this and the support desk need a public-facing intake path
      (someone reports content; a user opens a ticket) that doesn't exist
      anywhere in v2 yet. Building only the admin dismiss/resolve side
      would ship a screen that's permanently empty — confirmed with user
      2026-09-13 to skip for now rather than build dead scaffolding.
      Revisit once a real reporting/ticket intake surface is scoped
      (guest-portal or partner-dashboard side).
- [ ] Support ticket desk (timeline, internal notes, merge logic, SLA) —
      PAUSED, same reasoning as above.

## Phase D — Operator tooling — IN PROGRESS

- [x] Global entity lookup (omnibox) — DONE (2026-09-13). Ported v1's
      O(1)-parallel-fetch pattern (`lookup/route.js`), not a scan:
      `AdminOperationsService.globalLookup` fires `Promise.all` across
      venue/event/organization/user `getById` — all four already existed
      on their repository ports except `UserAccountRepository`, which
      gained `getById` for this (previously list-only). Below 3 chars
      returns `[]` without issuing any reads. Route: `GET /admin/lookup?q=`
      in `directory.ts`. Frontend: new `/lookup` page + nav entry — enter
      an exact id, get back type/name/id across all four collections.
      Full `pnpm check` (385 tests) + frontend turbo gate (58/58) green.
      **Scope note:** doc-id lookup only, matching v1's actual O(1)
      pattern — no slug/email fallback search (v1's own indexed-email
      lookup was a separate, secondary path; not ported here, add later
      if a real need shows up).
- [x] Audited CSV export with PII redaction — DONE (2026-09-13), scoped to
      the user directory (the one collection with real PII; venues/events/
      hosts carry none in their current DTOs). `GET
      /admin/users/export.csv` redacts email to `[redacted]` for every
      role except `super`/`finance` (v1's exact rule), audited as
      `ADMIN_EXPORT`/`user_directory` with row count. **Scope decision:**
      did NOT port v1's per-admin-role *read* matrix restricting which of
      venues/events/hosts/users each role may even list — v2's existing
      directory routes deliberately let any active admin read all four
      (see `directory.ts`'s own header comment), and narrowing that is a
      real access-policy decision, not an engineering default; left as-is
      rather than guessing a matrix.
- [x] Audit log target-name resolution — DONE (2026-09-13).
      `AdminOperationsService.resolveTargetNames` batch-resolves
      venue/event/organization/platform_user targets to a display name at
      READ time (`GET /admin/audit` and the audit CSV export), never
      baked into the write — matches the plan's "small lookup helper, not
      baked into the audit write itself." Unresolvable/unknown target
      types (proposed_action, platform_admin, audit_log, user_directory,
      onboarding_request) return `null`, not an error.
      **IP/UA capture — NOT done, real scope reason:** every admin write
      funnels through `AdminAuthorityService.record()`, called from
      ~25 call sites across ~10 route files; the plan deliberately rejects
      an AsyncLocalStorage shortcut in favor of explicit route→service
      passing, which means adding `ipAddress`/`userAgent` correctly means
      touching every one of those ~25 call sites (route handler extracts
      `request.ip`/`request.headers['user-agent']`, passes to the service
      method, service forwards into `AuditInput`) — a large, uniform,
      low-risk-per-edit but wide mechanical change. Left for a dedicated
      pass: `grep -rn "authority.record(" packages/core/src/application`
      lists every call site that needs the two new parameters threaded
      through from its route.
- [x] Admin role-update flow — DONE (2026-09-13, half-scope, see below).
      `ADMIN_ROLE_UPDATE` added as TIER3 (dual control, same
      execute-from-approved-proposal shape as `ADMIN_PROVISION`). Domain:
      `updatePlatformAdminRole` in `admin-authority.ts` (no-op if
      unchanged). Service:
      `AdminAuthorityService.updateAdminRoleFromProposal`. Route:
      `POST /admin/proposals/:proposalId/update-admin-role`. Frontend: the
      Admins desk gets a "Change role" trigger that raises the proposal
      (role select + required reason), and the Proposals desk gets an
      "Apply role update" execute button once a second admin approves —
      mirrors the existing Provision-admin pattern exactly.
      **v1's `claimsSynced` concept does not apply**: v1 needed it because
      role lived in Firebase custom claims, a cache that could fall out
      of sync with Firestore; v2's `PlatformAdmin.role` field IS the
      authority (`AdminAuthorityService` reads it directly, nothing else
      caches it), so there is no second store to desync from.
      **Admin invitation-by-email — NOT done, real scope reason:** v1's
      invite flow creates a brand-new Better Auth-equivalent account with
      a throwaway password and emails a signed reset link
      (`getSecureOrigin` header-injection defense included). V2's
      `ADMIN_PROVISION` already assumes the target user has an existing
      account (a deliberate, safer v2 simplification — promotion, not
      account creation) — porting v1's invite-a-brand-new-person flow on
      top would require calling Better Auth's server-side account-creation
      + password-reset-link-minting API.
      **API surface verified 2026-09-20 against `better-auth@1.6.26`
      (the installed version):** `auth.api.createUser` (admin plugin)
      supports passwordless account creation and, called server-side with
      no headers, skips its own role check — the route's `requireAdmin`
      gate stays the authority. Two blockers keep this deferred:
      1. The admin plugin declares its own `user.fields.role` which
         collides with our custom `additionalFields: { role }` in
         `apps/api-gateway/src/plugins/auth.ts` (both write that field) —
         a schema-merge decision, not a drop-in enable.
      2. No synchronous invite-token return: `requestPasswordReset` /
         magic-link only deliver the link via an email-send callback
         (without `emailAndPassword.sendResetPassword` it throws
         `RESET_PASSWORD_DISABLED`) and respond `{ status: true }`.
         `EmailSender` (`packages/core/src/domain/ports/email-sender.ts`)
         currently has only `sendOtpEmail`; a `sendInviteEmail` method +
         wiring into `buildBetterAuth` is the build path.

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

| Date | What happened |
| --- | --- |
| 2026-09-13 | Initial V1→V2 gap audit + Batch 1 (disputes desk) started. Full batch-by-batch log lives in `ADMIN-DASHBOARD-GAPS.md` §5 — this Session Log only records items that changed this phase's status. |
| 2026-09-16 | **Batch 4 + 5–9 progression** — analytics, health, tickets, promotions, promoters, and settings desks all shipped E2E. The "promoters read-only" and "settings read-only" rows in `ADMIN-DASHBOARD-GAPS.md` were the last two partial desks; both closed this day (see the two rows below). |
| 2026-09-16 | **Part D2 — promoter lifecycle verbs.** `PROMOTER_SUSPEND`/`PROMOTER_REINSTATE` (TIER2) with `PromoterAssignmentStatus` gaining `suspended` + `suspendedAt`; `suspendPromoterAssignment`/`reinstatePromoterAssignment` FSM (`active↔suspended`, `ended` terminal); `EventCatalogRepository.listAssignmentsByPromoter` (port+memory+firestore); routes `POST /admin/promoters/:promoterId/{suspend,reinstate}` (idempotent, `runIdempotent`); contracts + parity extended. Gate: `pnpm check` (core 504, api-gateway 418), parity 118/118. |
| 2026-09-16 | **Part D3 — platform settings singleton + refund-threshold wiring.** New `PlatformSettings` domain model (fee rate, single/dual refund ceilings 50K/500K paise, maintenanceMode, featureFlags); `PlatformSettingsRepository` port + memory + firestore (`v2_platform_settings/singleton`); `RefundService.requestRefund` now fetches live thresholds and threads them into `approversRequiredFor` (defaults = old constants, no behavior change without an admin edit). `AdminOperationsService.getPlatformSettings`/`updatePlatformSettings` (merge-update, requireAdmin). Routes GET+PUT `/admin/settings/platform` (PUT idempotent, `SENSITIVE_COMMAND`). Contracts `admin-settings.ts` `.strict()` schemas, parity-checked. `/settings` admin desk gains an editable platform settings card on the frontend; `format.tsx` fixed for the new D2 labels/status. Gate: backend `pnpm check` (core 504, api-gateway 426), parity 125/125; frontend admin-console lint/typecheck/test/build green. |
| 2026-09-20 | **IP/UA audit sweep complete (Commit 5).** `AuditRequestMeta { ipAddress?, userAgent? }` added to `domain/ports/audit.ts`; `AdminRequestMeta` in admin-ops is now an alias. Threaded trailing `meta?` through AdminOperations (12 methods), AdminAuthority (propose/approve/reject/cancel/resolve/provision/role-update/revoke), AdminPayout (freeze/release/runBatch), AdminDispute (resolve), Refund (request/approve/reject/settle) and Onboarding (approve/reject/request-changes) services. All 10 admin route files pass `requestMeta(request)` from the new `apps/api-gateway/src/lib/v2-request-meta.ts`. Audit DTO contract unchanged (still omits ip/user-agent); `directory.test.ts` VENUE_SUSPEND asserts raw-record capture. Gate: `pnpm check` green (contracts 13, core 523, api-gateway 434). |
| 2026-09-20 | **Admin invite-by-email API surface verified** against `better-auth@1.6.26` (details in the Phase D section above): passwordless `auth.api.createUser` works, but enabling the admin plugin collides with our custom `role` additionalField, and the reset-link APIs only deliver the token via an email-send callback (never synchronously). `EmailSender` port has only `sendOtpEmail`. Deferral now evidence-based, not a guess; build path documented. |

Phase D now reads DONE (admin invite-by-email still deferred — API surface verified 2026-09-20, see above); Phase C remains PAUSED on intake-path grounds (unchanged).
