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
| **KYC review desk** | `/kyc-review` (692 LOC) | Currently routed through onboarding — a dedicated review desk surfaces pending applications faster for large queues | No new backend; reuse `onboarding-review.ts` | `/kyc-review` filtered view of onboarding queue, doc-heavy layout |
| **Analytics dashboard** | `/analytics` (1,317 LOC) | Revenue/event/user metrics for ops decisions | New `analytics.ts` aggregate queries (revenue totals, ticket stats, active events) | `/analytics` charts + summary cards |

### Tier B: medium value, V1 has screens but deferred scope or blocked

| V1 feature | V1 LOC / page | Blocker / deferral rationale |
|---|---|---|
| **Support tickets** (timeline, internal notes, merge, SLA) | `/support` (3,692 LOC) | **PAUSED — no intake path.** Needs guest-portal ticket submission before admin desk makes sense. |
| **Safety reports / content moderation** (soft-delete, safety score) | `/safety` (3,052 LOC) | **PAUSED — same as support.** Needs public-facing reporting surface. |
| **Promotions admin** (codes, campaigns) | `/promotions` (2,514 LOC) | No V2 promo engine concept; currently handled via order-level promo codes in checkout. |
| **Promoters management** | `/promoters` (3,879 LOC) | V2 models promoters as `Organization` members with capability flags — no separate promoter entity to manage. Scope TBD. |
| **Settings** (admin profile, passwords) | `/settings` (1,525 LOC) | Admin profile = Better Auth; settings mostly dead code in V1 (password change via Auth UI). |
| **Health / system status** | `/health` (676 LOC) | Could be lightweight infra endpoint; low priority for product parity. |
| **Tickets list** (guest ticket management) | `/tickets` (894 LOC) | Different from support tickets; this is the ticket ledger view. Could share route with orders desk. |

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

**Batch 3 — KYC review filtered view**
- Frontend-only: `/kyc-review` as a filter-preset of `/onboarding` (status=submitted), doc-focused layout
- No backend changes needed

**Batch 4 — Analytics dashboard**
- Backend: new `analytics-admin.ts` (aggregate queries: revenue totals, tickets sold, active events, top orgs)
- Frontend: `/analytics` desk with summary cards + tables

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
| | Next: Batch 3 (KYC review filtered view, frontend-only) → Batch 4 (analytics, backend + frontend). |
