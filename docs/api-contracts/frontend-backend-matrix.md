# Frontend/backend integration matrix

**Status:** corrected 2026-08-29. The earlier draft pointed the session rows at
`/api/v2/session` and called `@c1rcle/api-client` a "stub" — the live route is
`/api/v2/auth/session` and the client has been rebuilt (real transport in
`packages/api-client/src/`). Endpoint truth is `apps/api-gateway/src/routes/v2/`
+ `docs/api-contracts/auth-and-permissions.md`, not this backlog.
**Legend:** CURRENT = frontend exists; TARGET = intended contract;
FIXTURE = frontend uses sample data; MISSING = no endpoint yet;
LIVE = endpoint exists and is tested; BLOCKED = 404 by absence (a later phase).

## Live vs blocked (backend, as of 2026-08-29)

- **LIVE:** `/api/v2/auth/*`, `/api/v2/onboarding/*`, `/api/v2/organizations*`
  (+ `/members`, `/invitations`, `/access`), `/api/v2/venues*`,
  `/api/v2/events*` (+ lifecycle), `/api/v2/events/:id/{ticket-tiers,
  promo-codes,table-packages,promoter-assignments}`,
  `/api/v2/organizations/:id/{partnerships,promoter-connections,analytics/overview}`,
  `/api/v2/events/:id/{analytics,referral-links}`, `/api/v2/admin/*`, and the
  Phase 5 door/scanner/cover-wallet routes (`/api/v2/door/*`,
  `/api/v2/cover-wallets/*`, `/api/v2/tickets/:id/qr`).
- **BLOCKED (404 — no route):** checkout, orders, payments, refunds, payouts,
  entitlement/ticket lists, `/api/v2/public/*` discovery, webhooks. Guest-portal
  and partner finance/orders screens stay FIXTURE until those land.

## Shared transport and session

| Frontend surface | Current source | Endpoint | Method | Auth | Frontend status | Note |
| --- | --- | --- | --- | --- | --- | --- |
| Shared API calls | packages/api-client/src/ | /api/v2/* | varies | central | Rebuilt transport; needs `reauth` + `Retry-After` | LIVE surface per list above |
| Session | packages/auth/index.ts | /api/v2/auth/session | GET | session cookie | In-memory store only; no network | LIVE — returns `{ user, expiresAt }` only |
| Login / signup / refresh / logout | DashboardAuthProvider.tsx (mock) | /api/v2/auth/{login,signup,refresh,logout} | POST | — / cookie | MOCK + 14 local `/api/auth/*` routes | LIVE (firestore driver); cookie/CSRF via a thin Next BFF |
| Memberships | select-organization/page.tsx | /api/v2/organizations | GET | bearer | UI exists, fixture data | LIVE — `{ items, pageInfo }` |
| Per-org permissions | DashboardAuthProvider (mock `['*']`) | /api/v2/organizations/:id/access | GET | bearer + X-Organization-Id | not called | LIVE — `partnerAccessDtoSchema` |

## Guest Portal

| Frontend route | Current data source | Target endpoint | Auth | Status |
| --- | --- | --- | --- | --- |
| / | home/explore fixtures | /api/v2/public/events plus editorial contract | public | FIXTURE |
| /explore | explore.fixture.ts | /api/v2/public/events | public | FIXTURE |
| /event/:eventId | event-detail.fixture.ts | /api/v2/public/events/:eventIdOrSlug | public | FIXTURE |
| /checkout/:id | booking.fixture.ts | quotes -> reservations -> orders -> payment intents | public/auth at defined steps | FIXTURE; integration MISSING |
| /confirmation/:id | booking fixture | /api/v2/orders/:orderId plus payment state | authenticated | FIXTURE |
| /tickets | tickets.fixture.ts | /api/v2/me/tickets | authenticated | FIXTURE |
| /profile | profile.fixture.ts | session + user profile contract | authenticated | FIXTURE |
| /profile/:userId | public profile fixture | public profile endpoint | public | FIXTURE |
| /hosts, /host/:id | directory fixtures | /api/v2/public/hosts/:slug | public | FIXTURE |
| /venue/:id | directory fixture | /api/v2/public/venues/:slug | public | FIXTURE |

## Partner Dashboard

| Frontend surface | Current source | Target endpoint | Auth/permission | Status |
| --- | --- | --- | --- | --- |
| Login/bootstrap | login/PageClient.tsx, DashboardAuthProvider.tsx | /api/v2/session | session | MOCK/local handlers |
| Onboarding/OTP | onboard/PageClient.tsx | approved onboarding/auth contract | public then authenticated | MOCK/local handlers |
| KYC status | verify/PageClient.tsx | approved KYC endpoint | organization/KYC permission | MOCK/local handlers |
| KYC upload | verify/PageClient.tsx | backend-issued upload session | authenticated | MISSING authoritative upload |
| Venue/host overview | partner repositories and venue screens | organization/venue overview | venue.read | FIXTURE |
| Events/create/edit | venue event screens | organization events + event commands | event.* | FIXTURE/endpoint mapping required |
| Guests/check-in | venue guest/door screens | event guests + door/check-in routes | guest/door permissions | UI exists; backend mapping required |
| Promoters/links | promoter/host repository interfaces | assignments + referral-links | scoped partner permissions | FIXTURE; adapter uses legacy /api/v1 |
| Finance/orders | finance screens/repositories | organization orders/finance routes | order/finance permissions | FIXTURE |
| Notifications | notification screens/models | organization notifications | authenticated | Presentation only; service missing |

## Admin Console

| Frontend surface | Current source | Target endpoint | Auth/permission | Status |
| --- | --- | --- | --- | --- |
| Shell/landing | apps/admin-console/src/app/page.tsx | Admin contract to be assigned | platform admin | Placeholder; MISSING data layer |

## Integration gates

A row moves from TARGET to INTEGRATED only when:

1. OpenAPI/schema exists and backend tests validate it.
2. API client transport and decoder are implemented.
3. Frontend consumer uses the shared client, not direct fetch/local route.
4. Auth, permission, loading, empty, error, retry, and cache behavior are tested.
5. Staging runtime proof confirms the real response and request ID.
6. Fixture imports are absent from the production path for that surface.

## Ownership

- Backend owns endpoint behavior, authorization, domain rules, provider calls,
  persistence, idempotency, and authoritative calculations.
- Frontend owns input collection, rendering, client state, cache orchestration,
  and honest error/loading states.
- Contract changes require updating this matrix, OpenAPI, and both client/server
  contract tests.
