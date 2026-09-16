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
| **Support tickets** (timeline, internal notes, merge, SLA) | `/support` (3,692 LOC) | **PAUSED — no intake path.** Needs guest-portal ticket submission before admin desk makes sense. |
| **Safety reports / content moderation** (soft-delete, safety score) | `/safety` (3,052 LOC) | **PAUSED — same as support.** Needs public-facing reporting surface. |
| **Promotions admin** (codes, campaigns) | `/promotions` (2,514 LOC) | No V2 promo engine concept; currently handled via order-level promo codes in checkout. |
| **Promoters management** | `/promoters` (3,879 LOC) | V2 models promoters as `Organization` members with capability flags — no separate promoter entity to manage. Scope TBD. |
| **Settings** (admin profile, passwords) | `/settings` (1,525 LOC) | Admin profile = Better Auth; settings mostly dead code in V1 (password change via Auth UI). |
| **Health / system status** | `/health` (676 LOC) | ✅ **DONE 2026-09-16** — `/health` desk live, frontend-only. Reuses the already-existing `GET /api/v2/internal/{readiness,version}` (unauthenticated ops-probe endpoints, unrelated to `@c1rcle/contracts`) rather than inventing a new admin-gated route. Shows exactly what `createReadinessChecks` checks (Firestore, storage, Redis, payment provider config) — no fabricated "Vision AI Node"/"CDN Edge" metrics like v1's version had (see the V1 audit doc's doc-vs-code mismatch table). |
| **Tickets list** (guest ticket management) | `/tickets` (894 LOC) | ✅ **DONE 2026-09-16** — `/tickets` desk live: platform-wide entitlement ledger, read-only. |

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
| `EVENT_FORCE_PAUSE` (force-complete past events) | Deferred in Phase B — requires event FSM edge to force-complete, not just pause/resume. | Phase B scope note |
| Admin invite-by-email | Needs Better Auth server-side account creation + password-reset-link API. Not built to avoid guessing the API surface. | Phase D scope note |
| Per-step KYC review state machine (7 states) | V2's `OnboardingRequest.status` serves the same purpose; adding a second FSM would duplicate state. | Phase B scope note |
| Admin role-based read matrix (restrict which views per role) | Deliberately not ported — V2 lets any active admin read all directories. Narrowing is a policy decision. | Phase D scope note |
| IP/UA capture in audit records | Mechanical: needs ~25 call sites updated across 10 route files. Scoped as a dedicated follow-up pass. | Phase D scope note |
| `partnerReprovision` | V2 unifies host/venue/promoter into Organization — no cross-type repair needed. | Phase B scope note |
| `claimsSynced` concept | V2's `PlatformAdmin.role` IS the authority — no cache desync possible. | Phase D scope note |

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
| | Remaining Tier B: support/safety — paused, no intake path; promotions/promoters/settings — scope TBD, not started. User asked for all remaining Tier B items, working through in order: tickets list (done) → promotions → promoters → settings. |
