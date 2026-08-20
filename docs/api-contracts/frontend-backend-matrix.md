# Frontend/backend integration matrix

**Status:** initial integration backlog
**Legend:** CURRENT = frontend exists; TARGET = intended backend contract;
FIXTURE = current frontend uses sample data; MISSING = endpoint/consumer proof
not available in this checkout.

The backend V2 route manifest and contract tests are the authority for live
status. This matrix intentionally does not mark planned endpoints as live.

## Shared transport and session

| Frontend surface | Current source | Target endpoint | Method | Auth | Frontend status | Backend status/gate |
| --- | --- | --- | --- | --- | --- | --- |
| Shared API calls | packages/api-client/index.ts | /api/v2/* | varies | central | Stub | Implement transport + DTO decoders |
| Guest session | packages/auth/index.ts | /api/v2/session | GET | session | In-memory only | Confirm web session/bootstrap |
| Partner session | DashboardAuthProvider.tsx | /api/v2/session | GET | session | Mock + local routes | Confirm membership/permission DTO |
| Organization picker | partner/select-organization/page.tsx | /api/v2/organizations | GET | authenticated | UI exists | Confirm list/switch semantics |

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
