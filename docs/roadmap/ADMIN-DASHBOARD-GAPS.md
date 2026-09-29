# V1→V2 Admin Dashboard — Parity Gap Backlog

> Living document. Ground truth: `docs/reference/V1 admin dashboard.md` (V1 audit)
> + `thec1rcle/apps/admin-console/` (actual V1 code), cross-referenced against
> `C1RCLE-FRONTEND/apps/admin-console/` + backend `routes/v2/admin/` as of 2026-09-13.
>
> Organized into three tiers: (1) now-possible E2E gaps, (2) backend-blocked gaps,
> (3) explicitly deferred items with decision rationale.

---

## 1. Current V2 E2E — fully live (client + backend + frontend)

| Feature | Backend route | Frontend desk | Notes |
|---|---|---|---|
| Onboarding review (approve/reject/request-changes + KYC doc read URLs) | `onboarding-review.ts` (13 routes) | `/onboarding` | TIER2 approve; doc URLs any admin |
| Refunds (amount-tiered approvals 0/1/2) | `refunds.ts` (5 routes) | `/refunds` | <₹500 auto, <₹5k single, ≥₹5k dual |
| Payouts (freeze/release/batch-run) | `payouts.ts` (5 routes) | `/payouts` | freeze/release = TIER3; batch-run = TIER2 |
| Proposals (raise/approve/reject/cancel + execute) | `onboarding-review.ts` propose endpoints | `/proposals` | dual-control for TIER3 actions |
| Directory (venues/events/hosts/users + CSV exports) | `directory.ts` (7 GETs) | `/venues` `/events` `/hosts` `/users` | CSV export: PII-redacted per role |
| Orders list (platform-wide, read-only) | `admin/orders.ts` (GET) | `/orders` | status + refundedPaise carried on the aggregate; filters client-side |
| Venue suspend/reinstate | `venue-actions.ts` (2 POST) | `/venues` | TIER2, direct command |
| Host/org suspend/reinstate | `organization-actions.ts` (2 POST) | `/hosts` | TIER2, direct command |
| Event pause/resume admin override | `event-actions.ts` (2 POST) | `/events` | TIER1, any admin, `adminOverride` flag |
| User ban/unban | `user-actions.ts` (2 POST) | `/users` | TIER2, separate `UserBan` aggregate |
| Admin provisioning + role update | proposal execute endpoints | `/admins` | ADMIN_PROVISION = TIER3; ROLE_UPDATE = TIER3 |
| Global lookup (omnibox) | `directory.ts` GET /admin/lookup | `/lookup` | O(1) parallel fetch, ≥3 chars |
| Audit trail + CSV export | `directory.ts` + authority service | `/audit` | target-name resolved at read time |
| Overview dashboard | aggregate reads | `/` | summary cards, pending queues |

---

## 2. Backend live, frontend missing (backend-only)

| Feature | Backend route | Status | Next step |
|---|---|---|---|
| **Disputes** (list + resolve upheld/denied) | `disputes.ts` (3 routes) | Backend 100% done | ✅ **DONE 2026-09-13** — `/disputes` desk + admin-api client live |
| Commission adjust (org-level fee override) | proposal execute endpoint in `admin-ops-service` | Backend 100% done; no standalone desk (proposals desk covers) | Could surface in host detail or add a dedicated `/commissions` desk |

---

## 3. No V2 counterpart (backend missing too) — prioritized backlog

### Tier A: high value, can build immediately (V1 screens exist, proven business need)

| V1 feature | V1 LOC / page | Why it's valuable | Backend work | Frontend work |
|---|---|---|---|---|
| **Orders/payments list** | `/payments` (1,152 LOC) | ✅ **DONE 2026-09-13** — `/orders` desk live (read-only list; see §1) | New `orders.ts` admin read-only route (`v2_orders` paginated via new `OrderRepository.listAll`) | `/orders` desk: table + status filters (order detail row = lower priority) |
| **KYC review desk** | `/kyc-review` (692 LOC) | ✅ **DONE 2026-09-15** — `/kyc-review` card-layout view, always scoped to `submitted`+`changes_requested`, documents shown up front per applicant | No new backend; reuse `onboarding-review.ts` | `/kyc-review` filtered view of onboarding queue, doc-heavy layout |
| **Analytics dashboard** | `/analytics` (1,317 LOC) | ✅ **DONE 2026-09-16** — `/analytics` desk live: net revenue, tickets sold, active events, top-5 hosts by revenue | `admin/analytics.ts` (`GET /admin/analytics`) — bounded scan (1000 orders/events/orgs) over `AdminOperationsService.getAnalyticsSummary`, not a full-collection reduce | `/analytics` stat cards + top-hosts table |

### Tier B: medium value, V1 has screens but deferred scope or blocked

| V1 feature | V1 LOC / page | Blocker / deferral rationale |
|---|---|---|
| **Support tickets** (timeline, internal notes, merge, SLA) | `/support` (1,360) | **PAUSED — no intake path.** Needs guest-portal ticket submission before admin desk makes sense. |
| **Safety reports / content moderation** (soft-delete, safety score) | `/safety` (366) | **PAUSED — same as support.** Needs public-facing reporting surface. |
| **Promotions admin** (codes, campaigns) | `/promotions` (357) | ✅ **DONE 2026-09-16** — `/promotions` desk live: platform-wide, read-only, cross-event promo code list. Correction: V2 already has a full promo engine (`PromoCode` domain model + `EventCatalogService.createPromotion`, partner-scoped per event) — the doc's earlier "no V2 promo engine" claim was wrong. Admin desk is a read-only cross-event view; creation stays a partner action. |
| **Promoters management** | `/promoters` (426) | ✅ **DONE 2026-09-16** — `/promoters` desk live (read-only list + suspend/reinstate lifecycle verbs). `PROMOTER_SUSPEND`/`PROMOTER_REINSTATE` TIER2 actions in `AdminAction` + `adminActionSchema`; `suspendPromoterAssignment`/`reinstatePromoterAssignment` FSM (`active↔suspended`, `ended` is terminal). Gate: `pnpm check` green (504+426 tests), parity 125/125. | `admin/promoters.ts` (GET list + POST suspend/reinstate), `admin-promoters.ts` contracts | `/promoters` desk | 
| **Settings** (admin profile, passwords) | `/settings` (411) | ✅ **DONE 2026-09-16** — `/settings` desk: read-only admin profile + platform settings editor (fee rate, refund thresholds, maintenance mode). `PlatformSettingsRepository` port + memory + firestore; `RefundService.requestRefund` fetches thresholds at request time. Gate: `pnpm check` green (504+426 tests), parity 125/125, frontend lint/typecheck/test/build green. | `admin-settings.ts` contracts, `admin/settings.ts` route (GET+PUT `/admin/settings/platform`), `PlatformSettings` domain model | `/settings` desk |
| **Health / system status** | `/health` (274) | ✅ **DONE 2026-09-16** — `/health` desk live, frontend-only. Reuses the already-existing `GET /api/v2/internal/{readiness,version}` (unauthenticated ops-probe endpoints, unrelated to `@c1rcle/contracts`) rather than inventing a new admin-gated route. Shows exactly what `createReadinessChecks` checks (Firestore, storage, Redis, payment provider config) — no fabricated "Vision AI Node"/"CDN Edge" metrics like v1's version had (see the V1 audit doc's doc-vs-code mismatch table). |
| **Tickets list** (guest ticket management) | `/tickets` (249) | ✅ **DONE 2026-09-16** — `/tickets` desk live: platform-wide entitlement ledger, read-only. |

### Tier C: low value or not porting by design

| V1 feature | Why not porting |
|---|---|
| **Content curation / explore** (`/content/curation`, `/content/explore`) | V2 discovery-weight field not implemented yet (deferred in Phase B scope decision). |
| **Security dashboard** (`/security`) | Mostly ornamental in V1; admin actions already have audit trail in V2. |
| **Logs viewer** (`/logs`) | V2 audit trail supersedes raw logs; logs are infrastructure, not product. |

---

## 4. Explicitly deferred items (decisions recorded in phase-07-admin-console.md)

| Item | Decision rationale | Phase file reference |
|---|---|---|
| `EVENT_FORCE_PAUSE` (force-complete past events) | ✅ **IMPLEMENTED 2026-09-18** — admin-only FSM edge (`FORCE_COMPLETABLE_STATUSES` = `published`/`sales_paused`/`started` → `ended`) in `event.ts` + `EVENT_FORCE_PAUSE` verb (`admin-authority.ts` TIER1, `onboarding.ts` `adminActionSchema`) + `AdminOpsService.forceCompleteEvent` + `POST /admin/events/:eventId/force-complete` (idempotent `admin.event.force_complete`) + events-desk button (`forceCompleteEvent` in admin-api). Stamps `adminOverride: true`, clears `isPublic`. Domain + route tests (11/11). | Phase B scope note |
| Admin invite-by-email | ✅ **API surface VERIFIED 2026-09-20** (better-auth 1.6.26, the installed version — not guessed): `auth.api.createUser` (admin plugin) supports passwordless account creation (`password` optional → "created without a credential account"); server-side calls with no headers bypass its role check, so our `requireAdmin` gate stays the real authority. **Deferred for two concrete reasons, both now proven:**
  1. **`role` field collision** — the admin plugin declares its own `user.fields.role` (schema.mjs) which conflicts with our custom `additionalFields: { role }` in `apps/api-gateway/src/plugins/auth.ts` (both write `user.fields.role`). Enabling it needs a schema-merge decision first, not a drop-in plugin add.
  2. **No synchronous invite-token return** — `requestPasswordReset` / magic-link both require an email-send callback (e.g. `sendResetPassword`; throws `RESET_PASSWORD_DISABLED` without one) and return only `{ status: true }`; the link/token goes to the callback, never to the route caller. The `EmailSender` port exists but has **only** `sendOtpEmail` (`packages/core/src/domain/ports/email-sender.ts`) — a `sendInviteEmail` method would need adding + wiring into `buildBetterAuth`.
  Build path when picked up: add admin() plugin (resolve role collision) → add `EmailSender.sendInviteEmail` → pass it as `emailAndPassword.sendResetPassword`. | Phase D scope note |
| Per-step KYC review state machine (7 states) | V2's `OnboardingRequest.status` serves the same purpose; adding a second FSM would duplicate state. | Phase B scope note |
| Admin role-based read matrix (restrict which views per role) | Deliberately not ported — V2 lets any active admin read all directories. Narrowing is a policy decision. | Phase D scope note |
| IP/UA capture in audit records | ✅ **IMPLEMENTED 2026-09-18 + SWEEP COMPLETE 2026-09-20** — `AuditInput`/`AdminAuditRecord` gained optional `ipAddress`/`userAgent`, persisted by `AdminAuthorityService.record`. `AuditRequestMeta` added to `domain/ports/audit.ts`; all remaining admin call sites (venue/org/user/payout/refund/promoter/settings/directory/onboarding-review desks) now thread `requestMeta(request)` from `apps/api-gateway/src/lib/v2-request-meta.ts` through trailing `meta?` args (Commit `1a67c7f`). Audit DTO contract unchanged (still omits ip/user-agent on the wire); `directory.test.ts` VENUE_SUSPEND asserts raw-record capture. | Phase D scope note |
| `partnerReprovision` | V2 unifies host/venue/promoter into Organization — no cross-type repair needed. | Phase B scope note |
| `claimsSynced` concept | V2's `PlatformAdmin.role` IS the authority — no cache desync possible. | Phase D scope note |
| Admin ledger viewer (`GET /api/ledger`, `getLedgerEntries` + state allowlist) | Finance/ledger browse is Phase 6 territory. V2 has no ledger read-model behind admin views yet; port it with the settlement engine, not before. | Phase C scope note |
| Elevated-risk gate (`ELEVATED_RISK_CONFIRMATION_REQUIRED` / `elevated_ack`) | V1 rejects critical actions from non-normal risk-tier admins until `elevated_ack: true` is re-submitted. V2 has no reputation/risk-tier model for admins; building one needs a source of risk signals. Recorded as deferral; revisit with a real abuse/token-revoke reflex. | Phase C scope note |
| `ADMIN_ACCESS_REVOKE` | V1 UI sends this verb but its own dispatcher has no `case` handler — would throw 'Unknown action'. Do not port a broken V1 surface; V2 admin-provisioning revocation is modeled via `ADMIN_ROLE_UPDATE` to a restricted role. | Audit 2026-09 |
| `VERIFICATION_ISSUE` / `VERIFICATION_REVOKE` | Venue/host/event verification status flags — not yet scoped for V2 admin console. Potential future follow-up. | Audit 2026-09 |
| `WARNING_ISSUE` | Admin-issued warning entity — V2 has no standalone warning aggregate yet. Potential future follow-up alongside notification system (Phase 8). | Audit 2026-09 |
| `WEBHOOK_RETRY` | V1 retries `failed_webhooks` via an admin verb — V2 fires webhooks idempotently from the payment route with automatic retries; no manual retry surface needed. | Audit 2026-09 |
| Platform announcements (V1: `ANNOUNCEMENT_CREATE`/`ANNOUNCEMENT_DELETE`) | No public announcement delivery surface exists yet; scoped with notifications (Phase 8). | Audit 2026-09 |
| **7→5 admin role narrowing** | V1 has 7 roles (`super`, `admin`, `ops`, `finance`, `content`, `readonly`). V2's `adminRoleSchema` has 5 (`super`, `admin`, `ops`, `finance`, `support`) — `content` and `readonly` deliberately dropped. `readonly` is a permissions concern (enforced at gateway via `requireAdmin`); `content` duties subsumed under `admin`. | Phase D scope note |

---

## 5. Execution batches (recommended order)

**Batch 1 — Disputes desk E2E** (DONE — executing 2026-09-13)
- Backend: already live (`disputes.ts` — list + get + resolve)
- Frontend: admin-api client + `/disputes` page + nav entry

**Batch 2 — Orders/payments admin list** (DONE 2026-09-13)
- Backend: `admin/orders.ts` read-only route over new `OrderRepository.listAll` (paginate `v2_orders`, `createdAt desc`); status + `refundedPaise` already live on the aggregate, so refund-state join needs no extra read
- Contracts: `admin-orders.ts` (`AdminOrderDto` lean summary + `paginatedSchema` envelope), re-exported via `@c1rcle/contracts/client`
- Frontend: `/orders` desk + `listOrders` admin-api client + `ORDER_STATUSES` (derived from schema) + nav entry
- Note: no new Firestore composite index — platform-wide list is equality-free on a single `createdAt` index

**Batch 3 — KYC review filtered view** (DONE 2026-09-15)
- Frontend-only: `/kyc-review` — card layout, always `submitted`+`changes_requested`, documents shown up front per applicant, same approve/reject/request-changes actions as `/onboarding`
- No backend changes needed

**Batch 4 — Analytics dashboard** (DONE 2026-09-16)
- Backend: `admin/analytics.ts` (`GET /admin/analytics`) over `AdminOperationsService.getAnalyticsSummary` — bounded scan (limit 1000) across orders/events/organizations, net revenue = grandTotalPaise − refundedPaise summed over captured orders (paid/refund_requested/refunded), tickets summed across order lines, active events via `isPublicStatus`, top 5 hosts by revenue
- Contracts: `admin-analytics.ts` (`AdminAnalyticsSummaryDto`, `AdminAnalyticsTopOrgDto`)
- Frontend: `/analytics` desk — 3 stat cards + top-hosts table + nav entry
- Note: `scannedOrders`/`scannedEvents` in the response report the real scan size honestly rather than claiming full-collection exhaustiveness (the Firestore pagination helper caps any internal `listAll` call at 100 regardless of the requested limit — same known constraint `exportUsers`/`exportAudit` already live with)

**Batch 5+ — Tier B items (when intake paths are scoped)**
- Support tickets: needs guest-portal intake + admin desk
- Safety reports: needs public reporting surface + admin desk




## Audit NoW BY Agents

| Date | Agent Name| What was built / decided |
| --- | --- | --- |
| 2026-09-16 | Opendcode | Both audits complete. Here's the synthesized picture and proposed plan.
1. V2 admin dashboard — how much is actually implemented
Fully wired E2E (route + service + desk): onboarding review, proposals (dual-control), refunds, payouts, disputes, directory (venues/events/hosts/users), venue/org/event/user action desks, admins, audit + CSV exports, lookup, overview, orders, analytics, health, kyc-review (single-FSM view), and per your note Tickets, Promotions, Promoters, Settings (all shipped). That's 15 admin route files + 14 route test files under apps/api-gateway/src/routes/v2/admin/.
Partial (backend fine, desk lighter than V1): settings (read-only profile — V1 had a platform-config editor), promotions (read-only — V1 also created), promoters (read-only — V1 had lifecycle verbs), analytics (live-scan but truncates at 1,000 rows and claims platform totals), events (no pin/unpin or discovery-weight).
Deliberately absent (scope-recorded): support + safety (no intake path), content moderation, content curation/explore, security dashboard, raw logs, per-step KYC 7-state FSM, webhook retry, announcements, verification/warning verbs, partner reprovision, invite-by-email/change-password.
2. V1 → V2 gaps the explore agent surfaced
Highest-value unported V1 capabilities: support desk semantics (timeline/merge/assign/SLA/CSAT — 10 methods, ~390 LOC), safety moderation, content moderation, platform settings editor (DATABASE_CORRECTION/FEE_RULE_UPDATE plurals), promoter lifecycle, admin access revoke (V1's own UI even fires a verb its dispatcher can't execute — don't blindly port), webhook retry. V1's 7 admin roles include content+readonly that V2's 5-role schema drops — a deliberate narrowing worth confirming.
3. V2 modular-monolith / doc gaps the general agent surfaced (ranked)
#	Gap
1	Analytics read-model never written — partner /analytics/overview always zeros, /events/:id/analytics always 404 (audit-consumers.ts:27 no-op createProjectionConsumer, nothing writes v2_analytics_reads)
2	ROADMAP.md says Phase 7 "not started" despite 15 admin route files + phase-07 doc
3	Three registered 501 stubs (/door/stats/ws, /door/offline-manifest) violate D-006 "never 501" + app.test.ts:132
4	Admin analytics truncates at 1k rows but exposes totalRevenuePaise as platform-wide
5	venueShareRate settles to 0 — real settlement gap (disclosed in ROADMAP)
6	No route tests for onboarding-review.ts (13 routes) and admin/orders.ts
7	Contract parity (63 checks) covers only pre-admin schemas — admin/checkout/order/phase5/6 drift ships silently
8	Modular-monolith layering itself is clean (no Firestore calls in gateway handlers; all service-wired)
Proposed plan
1. Fix the doc-trust breakers first (cheap, high value): ROADMAP Phase 1/7 rows, readiness.ts stale comment, deployment.md → historical flag, D-006 501 carve-out (document or remove stubs).
2. Fix the real data gaps: implement the analytics projection writer (or compute-on-request for partner overview), fix admin-analytics truncation (cursor iteration + window labels).
3. Harden what's shipped: add route tests for onboarding-review + orders; extend contract-parity.mjs to cover the admin/checkout/phase5/6 schemas.
4. Update ADMIN-DASHBOARD-GAPS.md + phase-07 with the fresh V1 inventory (the explore audit found V1 page LOC figures in the gaps doc are inflated — e.g. support is 1,360 not 3,692 — and flagged 2 V1 verbs that are broken in V1 itself).
5. Decide (needs your call): port promoter lifecycle + admin access-revoke + platform settings editor, or keep them scope-recorded as no-ops? Confirm the 7→5 role narrowing.
Want me to proceed with 1–4 (all read-only-adjacent fixes + doc updates + tests + parity), or start on the #1 analytics fix first? And should the V1 porting decisions (#5) default to "record as deliberate deferral" for now? |

---

## Session Log

| Date | What was built / decided |
|---|---|
| 2026-09-13 | Initial gap audit created. Verified V1 claims against actual `thec1rcle` source (tiers, dual-approval, amount-tiered refunds, previousStatus restore, DUAL_APPROVAL config). V2 E2E confirmed for 12 features. 2 backend-only features (disputes, commission-adjust). 7+ Tier A–B features missing entirely. Batch 1 (disputes desk) execution started. |
| 2026-09-13 | **Batch 1 DONE** — disputes desk E2E: `contract-types.ts` (DisputeStatus/Outcome), `format.tsx` (labels + tone), `admin-api.ts` (`listDisputes`/`resolveDispute`), `/disputes` page, nav entry. Gate: turbo lint/typecheck/test/build on admin-console 16/16. |
| 2026-09-13 | **Batch 2 DONE** — orders desk E2E. Backend: `OrderRepository.listAll` (port + memory + firestore), `AdminOperationsService.listOrders`, `admin-orders.ts` contracts, `admin/orders.ts` route registered in manifest. Gates: `pnpm check` green (format/lint/typecheck/boundaries/391 tests/build), contract-parity 63/63. Frontend: contracts synced via export-contracts, `/orders` desk + `listOrders` + `ORDER_STATUSES` + nav entry. Gate: turbo 16/16 on admin-console. No new Firestore composite indexes. |
| 2026-09-15 | **Batch 3 DONE** — KYC review desk: `/kyc-review` frontend-only, card layout scoped to `submitted`+`changes_requested`, documents shown up front. Nav entry added. Gate: turbo lint/typecheck/test/build 58/58 on full frontend monorepo. |
| 2026-09-16 | **Batch 4 DONE** — analytics desk E2E. Backend: `AdminOperationsService.getAnalyticsSummary` (bounded scan, not a full-collection reduce — the exact v1 `computePlatformStats` anti-pattern avoided), `admin-analytics.ts` contracts, `admin/analytics.ts` route registered in manifest. Gate: `pnpm check` green (format/lint/typecheck/boundaries/394 tests/build), contract-parity 63/63. Frontend: `/analytics` desk (3 stat cards + top-5-hosts table) + `getAnalyticsSummary` + nav entry. Gate: turbo 58/58 on full frontend monorepo. |
| | All four Tier-A batches done. |
| 2026-09-16 | **Health/system status DONE** — `/health` desk, frontend-only, no new backend route. Reuses the pre-existing `GET /api/v2/internal/{readiness,version}` ops-probe endpoints directly (real Firestore/storage/Redis/payment-provider checks, not a new admin route or fabricated metrics). Gate: turbo lint/typecheck/test/build 58/58. |
| 2026-09-16 | **Tickets list DONE** — `/tickets` desk: `EntitlementRepository.listAll` (memory+firestore), `AdminOperationsService.listTickets`, `admin-tickets.ts` contracts, `admin/tickets.ts` route registered in manifest. Gate: `pnpm check` green (396 tests), contract-parity 63/63. |
| 2026-09-16 | **Promotions + Promoters DONE** — `/promotions` and `/promoters` desks: `EventCatalogRepository.listAllPromos`/`listAllAssignments` (memory+firestore), `AdminOperationsService.listPromotions`/`listPromoterAssignments`, `admin-promotions.ts`/`admin-promoters.ts` contracts, routes registered. Gate: `pnpm check` green (400 tests), boundaries clean, contract-parity 63/63. |
| 2026-09-16 | **Settings DONE** — `/settings` desk, frontend-only, no backend changes: read-only admin profile matched from `listAdmins()` against the session user id. |
| | All Tier B items resolved except support tickets and safety reports, which remain PAUSED pending a public-facing intake surface in guest-portal/partner-dashboard. |
| 2026-09-16 | **Batch 6 / parity-audit execution** — doc-trust repairs (ROADMAP Phase 1/5/7 rows corrected, `readiness.ts` stale comment fixed); V1 LOC figures corrected (support 1,360, safety 366, promotions 357, promoters 426, settings 411, health 274, tickets 249); ADMIN_ACCESS_REVOKE + verification/warning verbs + webhook retry + announcements + 7→5 role narrowing all logged as explicit deferrals (§4); promoter lifecycle + platform-settings editor BUILDING as part of this batch; onboarding-review + orders route tests and contract-parity coverage extensions in progress. |
| 2026-09-16 | **Part D2 DONE — promoter lifecycle verbs.** Domain: added `suspended` status to `PromoterAssignmentStatus`, `suspendedAt` field to `PromoterAssignment`, `suspendPromoterAssignment`/`reinstatePromoterAssignment` FSM functions (`active↔suspended`, `ended` is terminal). Repo: added `listAssignmentsByPromoter` to `EventCatalogRepository` (port + memory + firestore). Service: `AdminOperationsService.suspendPromoter`/`reinstatePromoter` (bulk, idempotent, 0-affected on repeat). Routes: POST `/admin/promoters/:promoterId/suspend` + `/reinstate` (idempotent, `SENSITIVE_COMMAND` rate limit, `runIdempotent` pattern matching venue-actions). Contracts: `adminPromoterSuspendRequestSchema`, `adminPromoterActionResponseSchema`, `adminPromoterAssignmentStatusSchema` updated to include `'suspended'`, `adminActionSchema` updated with `PROMOTER_SUSPEND`/`PROMOTER_REINSTATE`, both new schemas exported from `client.ts`. Core `AdminAction` type updated. Gate: `pnpm check` green (core 504 tests, api-gateway 418 tests), contract-parity 118/118 clean. |
| 2026-09-16 | **Part D3 DONE — platform-settings editor + refund threshold wiring.** Domain model: `PlatformSettings` + `PlatformSettingsInput` + `PLATFORM_SETTINGS_DOC_ID` (singleton) + `DEFAULT_PLATFORM_SETTINGS` (0.15 fee, 50K/500K paise, maintenanceMode false). Repo: `PlatformSettingsRepository` port (`get`/`save`) + `MemoryPlatformSettingsRepository` + `FirestorePlatformSettingsRepository` (`v2_platform_settings/singleton` doc). `approversRequiredFor` + `createRefundRequest` now accept optional `RefundThresholds`; `RefundService.requestRefund` fetches `platformSettings.get()` at request time and threads thresholds into the amount-tier calculation. Service: `AdminOperationsService.getPlatformSettings`/`updatePlatformSettings` (merge-update, requireAdmin). Routes: GET + PUT `/admin/settings/platform` (idempotent, `SENSITIVE_COMMAND` rate limit). Contracts: `platformSettingsDtoSchema`, `platformSettingsUpdateRequestSchema` (`.strict()`), both exported + parity-checked. Frontend: `/settings` desk gains editable platform settings card (fee rate, single/dual thresholds, maintenance mode toggle, dirty-state Save). `format.tsx` updated for `PROMOTER_SUSPEND`/`PROMOTER_REINSTATE` labels and `'suspended'` status badge. Gate: backend `pnpm check` green (core 504 tests, api-gateway 426 tests), contract-parity 125/125 clean; frontend `pnpm --filter @c1rcle/app-admin-console lint typecheck test build` all green. |
| 2026-09-19 | **Hardening F1–F5 test-locked + doc-truth corrections** (branch `admin-payout-controls`). F1: `PROMOTER_SUSPEND`/`PROMOTER_REINSTATE` added to `TIER2_ACTIONS` (domain `admin-authority.ts`). F2/F3: `suspendPromoter`/`reinstatePromoter` now `authorize()` + audit `record()` with before/after assignment deltas (targetType `promoter`), `affected: 0` on repeat with no duplicate audit. F4: `updatePlatformSettings` audits `PLATFORM_SETTINGS_UPDATE` (targetType `platform_settings`, targetId `singleton`, before/after settings snapshot). F5: `POST /admin/admins/:adminId/revoke` wrapped in `runIdempotent` (`admin.revoke`) so gateway replays can't double-audit. All fixes typed by failing tests first (red at core 5 + gateway 5 → green core 523 passed/4 skipped, gateway 434 passed), including idempotent-replay route tests for suspend/revoke. Docs corrected: ROADMAP+GAPS "24 admin route files" → 15 route + 14 test files; `docs/README.md` phase bullets (7 done, 8 next); IMPLEMENTATION-STATUS banner → superseded by ROADMAP; V1 admin dashboard reference V2-state paragraph marked stale; checkout.md + frontend-backend-matrix.md BLOCKED flags unflipped (Phase 4 LIVE); nginx README status + topology → sidecar-interim deployed on Render; GAPS §4 records ledger viewer + elevated-risk-gate deferrals (Phase C). |
| | Phase B (nginx production rollout) DROPPED — nginx already deployed on Render via sidecar interim; doc-only fix landed this session. Phase C = 3 deferrals recorded in §4 (ledger viewer, admin risk-tier/elevated-ack, RBAC read granularity) + 7→5 role-narrowing confirmed; no code. |
