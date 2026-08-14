# V2 Frontend → API Gateway Mapping (source of truth: `C1RCLE-BACKEND/docs/reference/*` + `C1RCLE-BACKEND/task.md`)

> Contract principle: **backend owns the API gateway; the frontend imports it.**
> All network traffic must go through `@c1rcle/api-client` → Fastify gateway
> (`/api/v2`) only. No direct Firebase, no app-local business APIs, no
> client-side `fetch` outside the client, no mock data in UI flows.
>
> Repos: frontend = `C1RCLE-FRONTEND` (@ `2f778a2`, 2026-08-12), backend =
> `C1RCLE-BACKEND` (B-series Phase 0 done 2026-08-13 — see
> `docs/roadmap/phase-00-foundation.md`). Reference (frozen T-series):
> `thec1rcle/` verified T01–T08 patterns.
>
> Slice scope: **Auth + Organizations + Venues + Events** was the frozen
> first slice and is now complete (Phase 0,
> `docs/roadmap/phase-00-foundation.md`). Per `docs/architecture/decisions.md`
> D-008 (2026-08-13), scope now extends to a phased full-platform roadmap — see
> `docs/roadmap/ROADMAP.md`. A domain not yet in an active phase still 404s
> by absence (D-006 unchanged), it just isn't "BLOCKED forever" anymore.

---

## 1. Current frontend API surface (`apps/partner-dashboard`)

### 1.1 App-local Next.js route handlers (all MOCK — `src/app/api/**`)

| # | Method + path (frontend today) | Returns today (mock) | Gateway target | Manifest status | Action |
|---|---|---|---|---|---|
| F1 | `GET /api/auth/me` | demo user `user_demo_123`, `isApproved:true` | `GET /api/v2/auth/session` (B10; alias of `session.get`) | `session.get` DEFERRED → activated as auth bridge per B10 | **Replace** with session endpoint; delete route |
| F2 | `POST /api/auth/otp/send` | "Dummy Code: 123456" | none — OTP is out of slice (Better Auth chosen over OTP-first flows) | no manifest entry | **Delete**; OTP auth later slice |
| F3 | `POST /api/auth/otp/verify` | accepts any 6-digit code | none | no manifest entry | **Delete** |
| F4 | `POST /api/auth/create-account` | mock `customToken` | `POST /api/v2/auth/signup` (Better Auth sign-up; extend B10 with signup route) | TBD under B10 — B10 currently defines login/refresh/logout/session only | **Extend B10** with signup decision |
| F5 | `POST /api/auth/onboard` | mock `pending_approval` | `POST /api/v2/onboarding/applications` then `.../submit` | **LIVE** (Phase 2) | **Replace** |
| F6 | `PATCH /api/auth/onboarding-progress` | mock | `PATCH /api/v2/onboarding/applications/:requestId` | **LIVE** (Phase 2) | **Replace** |
| F7 | `GET /api/auth/partner-context` | `grantedPermissions: ['*']` | later: session bootstrap; today nothing in slice | `session.sync` DEFERRED | **Delete**; permissions come from gateway RBAC, never `'*'` |
| F8 | `GET`/`POST /api/auth/check-availability` | `{ available: true }` | none (fold into signup validation → 400/409) | no manifest entry | **Delete** |
| F9 | `POST /api/auth/check-email` | `exists: false` | none (fold into signup validation) | no manifest entry | **Delete** |
| F10 | `GET /api/auth/onboard-status` | mock | `GET /api/v2/onboarding/me` | **LIVE** (Phase 2) | **Replace** |
| F11 | `POST`/`PATCH /api/auth/profile` | mock | none in slice (profile ≠ session) | no manifest entry | **Delete**; profile later slice |
| F12 | `GET /api/kyc` | mock `kycStatus` | `GET /api/v2/onboarding/me` (`documents` + `missingDocuments`) | **LIVE** (Phase 2) | **Replace** |
| F13 | `POST /api/kyc/upload` | mock | `POST /api/v2/onboarding/applications/:requestId/documents` (client uploads to storage first; signed-URL issuing still deferred) | **LIVE** (Phase 2) | **Replace** |
| F14 | `POST /api/kyc/verify-aadhaar` | mock | `POST /api/v2/onboarding/verify-document` — **advisory only**, `provider: 'format-check'` is not identity verification (D-018) | **LIVE** (Phase 2) | **Replace**, and never render as "verified" |

### 1.2 Direct calls from client components (violations today)

| # | File(s) | Call today | Required change |
|---|---|---|---|
| C1 | `DashboardAuthProvider.tsx`, `login/PageClient.tsx`, `onboard/PageClient.tsx`, `verify/PageClient.tsx` | raw `fetch('/api/auth/me' ...)` (5+ sites) | `@c1rcle/api-client` typed call; no raw fetch (architecture doc single-owner rule) |
| C2 | `onboard/PageClient.tsx` | `firebase/auth` `signInWithEmailAndPassword`, `signInWithCustomToken` | replaced by `@c1rcle/auth` session flow (Bearer from memory + httpOnly cookie) |
| C3 | `DashboardAuthProvider.tsx` | `firebase/auth` `signInWithPopup` (Google) | Better Auth social later; out of slice → remove |
| C4 | `src/lib/firebase/client.ts` | **mock** Firebase auth + `localStorage` session (`c1rcle.mock-auth.session`) | **Delete** — contradicts memory-only token rule + no-backend-SDK posture |
| C5 | `verify/PageClient.tsx:715` | `fetch('https://ifsc.razorpay.com/...')` | backend-owned lookup later (bank-accounts BLOCKED) → delete now; no external fetch from client |
| C6 | `src/lib/rbac/types.ts` | frontend-declared RBAC types | keep only as render hints; gateway is authority (B10 RBAC+ABAC) |

### 1.3 Venue Studio (`src/components/venue/**`) — mock UI, zero API

| # | Screen | Data today | Gateway target (manifest) |
|---|---|---|---|
| V1 | `OverviewScreen` | `data.ts` (1266-line mock) | `organization-analytics` (PLANNED) + `finance` (BLOCKED) — show real data only from slice routes |
| V2 | `EventsScreen` / `EventDetailScreen` / `CreateEventScreen` | mock | `events.list` `events.get` `events.create` `events.update` + actions review/publish/pause/resume/cancel/duplicate (`/api/v2/organizations/:organizationId/events`, `/api/v2/events/:eventId/...`) |
| V3 | `SlotRequestsScreen` | mock | `venue-slot-requests.list/create` (`/api/v2/venues/:venueId/slot-requests`) |
| V4 | `MarketingScreen` | mock | campaigns BLOCKED → button states only, no calls |
| V5 | `FinanceScreen` | mock | finance/payouts/bank BLOCKED → render "coming later", no calls |
| V6 | `PartnersScreen` | mock | promoters BLOCKED in slice (promoter-assignments PLANNED later) |
| V7 | `SettingsScreen` / `CalendarModal` / `DoorModeScreen` | mock | venue-profile/menu/calendar = PLANNED; door BLOCKED |
| V8 | `store.tsx` | pure UI state | fine — keep, but data must come from gateway |

---

## 2. Target gateway surface (C1RCLE-BACKEND, per B-series + manifest)

All under `/api/v2` on port 8080. Auth = Better Auth with httpOnly cookie +
in-memory Bearer access token + `Session{user, expiresAt}` (frontend contract).

| Gateway route (target) | Frontend consumer (target) | Manifest entry | Notes |
|---|---|---|---|
| `POST /api/v2/auth/login` | `@c1rcle/auth` | (B10) | sets cookie; returns `{user, accessToken, expiresAt}` |
| `POST /api/v2/auth/refresh` | `onUnauthorized` hook | (B10) | no session breakage on reload |
| `POST /api/v2/auth/logout` | `@c1rcle/auth` | (B10) | destroys session + cookie |
| `GET /api/v2/auth/session` | session bootstrap | `session.get` | 401 when none |
| `GET/POST /api/v2/organizations` | org screens | `organizations.list/create` | |
| `GET/PATCH /api/v2/organizations/:organizationId` | org settings | `organizations.get/update` | If-Match, Idempotency-Key |
| `GET /api/v2/organizations/:organizationId/members` | team UI | `organization-members.list` | |
| `POST /api/v2/organizations/:organizationId/members` | invite | `organization-members.invite` | |
| `GET /api/v2/organizations/:organizationId/invitations` | invitations UI | `organization-invitations.list` | |
| `GET/POST /api/v2/organizations/:organizationId/venues` | venue list/create | `venues.list/create` | |
| `GET/PATCH /api/v2/venues/:venueId` | venue edit | `venues.get/update` | |
| `GET/PATCH /api/v2/venues/:venueId/profile` | settings/public | `venue-profile.get/update` | |
| `GET /api/v2/venues/:venueId/calendar` | calendar UI | `venue-calendar.get` | |
| `PUT /api/v2/venues/:venueId/menu` | menu settings | `venue-menu.update` | |
| `GET /api/v2/venues/:venueId/availability` | availability UI | `venue-availability.get` | |
| `GET/POST /api/v2/venues/:venueId/slot-requests` | slot requests | `venue-slot-requests.list/create` | |
| `GET/POST /api/v2/organizations/:organizationId/events` | events list/create | `events.list/create` | |
| `GET/PATCH /api/v2/events/:eventId` | event detail/edit | `events.get/update` | |
| `GET /api/v2/events/:eventId/previews` | preview | `event-previews.get` | |
| `POST /api/v2/events/:eventId/{review,publish,pause-sales,resume-sales,cancel,duplicate}` | event actions | `events.*` | idempotent + If-Match |
| `GET /api/v2/events/:eventId/ticket-tiers` etc. | event catalog | `event-ticket-tiers.*` (PLANNED, next) | |

**BLOCKED (404 — never registered):** checkout, orders, payments, refunds,
payouts, bank-accounts, door, webhooks, KYC/onboarding, campaigns, analytics
routes beyond PLANNED, admin, notifications, social, public discovery.

---

## 3. Acceptance rules (who enforces what)

1. **Frontend:** `@c1rcle/api-client` is the ONLY network owner (already a lint
   rule per `docs/architecture/README.md` — today's raw `fetch` calls violate
   it). `@c1rcle/auth` is the ONLY session owner.
2. **Backend guardrails (C1RCLE-BACKEND `scripts/`):** no `process.env` in
   domain; no Fastify/Firebase in domain; no `.collection(`/`.doc(` in routes;
   no `fetch` outside transport layer.
3. **Parity mechanism (B02/B13):** `scripts/contract-parity.mjs` diffs
   `C1RCLE-FRONTEND/packages/types` + `api-client` schemas against
   `C1RCLE-BACKEND/packages/contracts`; contract changes go backend-first.
4. **Frontend posture (architecture README):** no backend SDKs, no Firebase
   Admin, no secrets, no `process.env` outside `@c1rcle/config`.
5. `NEXT_PUBLIC_API_BASE_URL` (already declared in `@c1rcle/config` schema) is
   the only backend address the client knows: `http://localhost:8080` dev.

---

## 4. Immediate remediation backlog (frontend, in order)

1. **Delete all 14 mock app-local routes** (`src/app/api/**`) — they are the
   opposite of the contract (mock demo data behind real-looking paths).
2. **Delete `src/lib/firebase/client.ts` + all `firebase/auth` imports** in
   partner-dashboard; replace with `@c1rcle/auth` (currently a stub → build the
   real one against B10).
3. Replace every raw `fetch('/api/...')` with `@c1rcle/api-client` calls
   (client is currently a stub → implement `createApiClient` with
   `x-request-id`, Bearer provider, `statusToErrorCode`, `RequestId`, 204
   handling per `C1RCLE-BACKEND/task.md` §0 frontend-contract).
4. Delete IFSC external fetch; remove KYC/onboarding/OTP UI until their slices
   exist (BLOCKED).
5. Wire Venue Studio screens to gateway routes (V1–V8 above) after B10–B11
   land; until then screens must render empty/unauthorized states, not mock data.

---

## 5. Open decisions to resolve (tracked in B-series §6)

- B10 signup: Better Auth has email/password sign-up — decide route +
  contract (`POST /api/v2/auth/signup`?) and add to B10/B11.
- Social (Google) login: deferred; confirm with Better Auth `socialProviders`
  later.
- Session alias: `GET /api/v2/auth/session` vs manifest `GET /api/v2/session`
  — B10 records the alias decision; frontend must use exactly one.