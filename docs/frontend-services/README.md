# THE C1RCLE frontend services architecture

**Status:** source-grounded architecture inventory
**Audited:** 2026-08-20
**Repository:** C1RCLE-FRONTEND checkout at /Users/aayushdivase/Desktop/thec1rcle
**Audited HEAD:** cecbc8587fd266e8245320fa96d4182882cc4eef on staging

This is the authoritative index for frontend service and service-like layers in
the canonical checkout. It describes what the source does now, not what a route,
package name, comment, or design document says it will do later.

## Reading this document

| Label | Meaning |
| --- | --- |
| CURRENT | Implemented in the audited checkout and used by an application. |
| TARGET | Required production responsibility or explicit integration seam; not proof of implementation. |
| LEGACY | Older or transitional implementation that remains in the checkout. |
| FIXTURE | Static or in-memory sample data used by a page or repository. |
| MOCK | Behavior that imitates an external system without contacting its authority. |
| UNUSED | Implemented or declared, but no production consumer was found in tracked source. |
| MISSING | Required capability for the target architecture with no authoritative implementation found. |

No frontend service may become an authority for identity, permissions, event
availability, inventory, price, orders, payments, tickets, check-ins, finance,
or audit history. Those values must come from the production backend and its
provider authority.

## System map

### Current source topology

~~~text
Admin Console       ─┐
Guest Portal        ─┼─> mostly static UI / fixtures; no working shared transport
Partner Dashboard   ─┘    ├─ local Next route handlers under /api/auth and /api/kyc
                           ├─ mock Firebase-like auth and localStorage session
                           └─ fixture Partner repositories

Declared shared packages:
@c1rcle/api-client  = error-shaped stub only
@c1rcle/auth        = in-memory React session store
@c1rcle/config      = validated environment access
@c1rcle/providers   = theme + React Query defaults
@c1rcle/types       = API error/pagination types
~~~

### Target production topology

~~~text
Frontend apps
  -> typed @c1rcle/api-client
  -> backend /api/v2
  -> authentication/session boundary
  -> authorization and active-organization context
  -> backend application/domain services
  -> Firestore/provider authority

Redis, queues/outbox, payment providers, notification providers, and storage
remain backend-owned integrations. The browser may request and display their
results, but must not call provider credentials or reproduce their decisions.
~~~

The target topology is an architectural destination. It is not the current
runtime of this checkout.

## Frontend application and package inventory

Only tracked files in the canonical Git worktree are included. The checkout
also contains untracked nested repositories, recovery copies, an API gateway,
mobile app, and scanner app. Those are not treated as authoritative frontend
source for this document.

| App/package | Purpose | Runtime | Status | Main consumers |
| --- | --- | --- | --- | --- |
| apps/partner-dashboard | Venue, host, and promoter UI, onboarding, auth, KYC | Next.js 16 / React 19 | CURRENT UI; FIXTURE/MOCK data | Partner roles |
| apps/guest-portal | Discovery, event detail, checkout presentation, tickets, profile | Next.js 16 / React 19 | CURRENT UI; FIXTURE | Guests |
| apps/admin-console | Minimal admin shell and placeholder landing screen | Next.js 16 / React 19 | CURRENT shell; MISSING data services | Admin operators |
| packages/api-client | Intended common backend transport and error taxonomy | TypeScript library | CURRENT stub; MISSING transport | Declared by manifests; no runtime call found |
| packages/auth | Shared browser session store and hooks | React client library | CURRENT in-memory compatibility layer | Guest tickets/profile |
| packages/config | Zod validation for public/server environment variables | TypeScript library | CURRENT | App/package configuration |
| packages/providers | Theme and TanStack Query providers | React client library | CURRENT provider shell; partial error policy | App layouts |
| packages/types | API error, request ID, pagination types | TypeScript library | CURRENT declarations; not transport | Future client and packages |
| packages/design-system, ui, icons | Tokens, visual components, semantic icons | React/CSS libraries | CURRENT presentation packages | Apps |
| packages/hooks, utils | Generic hooks and formatting/class helpers | TypeScript/React libraries | CURRENT utility packages | Apps/packages |
| packages/eslint-config | Network/env ownership and boundary rules | ESLint config | CURRENT guardrail | Workspace |
| packages/tailwind-config | Shared Tailwind theme/base | CSS package | CURRENT presentation package | Next apps |
| mobile/scanner source | Mobile client and scanner | Not tracked here | MISSING from authoritative checkout | Separate worktrees |

## Service catalog

### API client and request transport

Source: packages/api-client/index.ts, index.js, index.d.ts.

The package exports only isApiClientError, which always returns false, and
ApiClientError, whose isRetryable field is false. There is no base URL
resolution, request method, headers, timeout, abort handling, response decoding,
request ID generation, authentication injection, or /api/v2 call implementation.
No tracked runtime import was found; app manifests declare the package.

**Status:** CURRENT stub / MISSING production transport / TARGET shared owner.

**Production responsibility:** be the only frontend transport for backend calls.
Own the validated API base URL, relative endpoint construction, request IDs,
session header or cookie boundary, timeout/abort behavior, JSON parsing, typed
error normalization, and response decoding.

**Must not own:** Firestore, Firebase Admin, business rules, authorization
decisions, inventory/price/order/payment authority, provider secrets, or fixture
fallback.

**Disposition:** RETAIN the package boundary; REPAIR/IMPLEMENT the transport;
remove direct app fetch calls after migration.

### API error and response types

Source: packages/types/src/api.ts.

The package defines ApiErrorCode, ApiError, branded RequestId, PageInfo, and
Paginated<T>. The taxonomy covers network, timeout, abort, auth,
authorization, not-found, conflict, validation, rate limit, server, parse,
and unknown failures.

**Status:** CURRENT declarations / TARGET client contract.

**Responsibility:** provide stable transport-level types used by the client and
app state. Domain DTOs should be decoded at the boundary.

**Must not own:** domain policy or the illusion that a type declaration proves a
working endpoint.

**Disposition:** RETAIN; connect it to the real client and contract tests.

### Environment and runtime configuration

Source: packages/config/src/env.ts and schema.ts.

This is the only allowed process.env owner. Zod requires public
NEXT_PUBLIC_API_BASE_URL, app name, environment, and optional Sentry DSN; server
values are NODE_ENV and ANALYZE. Invalid environment fails on access.

**Status:** CURRENT.

**Responsibility:** validate configuration and prevent secrets from entering the
browser bundle.

**Must not own:** secrets, auth tokens, provider credentials, or silent fallback
URLs.

**Disposition:** RETAIN; make the implemented API client its only API-base consumer.

### Shared session/auth compatibility store

Source: packages/auth/index.ts.

The package exposes useSessionStore, useSession, getAccessToken, setSession,
clearSession, and markAnonymous. State is in memory only; it does not persist,
refresh, bootstrap from a server-visible session, or contact Firebase/backend.
auth.currentUser is a null compatibility export.

Consumers are Guest Portal tickets/profile components and tests. Partner
Dashboard uses a separate provider.

**Status:** CURRENT compatibility layer / PARTIAL / TARGET session API.

**Responsibility:** expose one session boundary with server bootstrap,
loading/anonymous/authenticated states, credential refresh/invalidation, and
safe identity context for the API client.

**Must not own:** role or permission policy, Firebase Admin operations, or domain
authorization.

**Disposition:** RETAIN the public seam; REPAIR it with the approved auth
boundary; remove duplicate role-specific auth implementations.

### Partner Dashboard Firebase-like auth adapter

Source: apps/partner-dashboard/src/lib/firebase/client.ts.

This file is explicitly a mock. Any email/password is accepted, partner type is
derived from the URL, mock_token_* values are returned, and a demo session is
persisted in localStorage under c1rcle.mock-auth.session. getFirebaseStorage()
returns an empty object.

DashboardAuthProvider.tsx consumes this adapter, Firebase helpers, local
/api/auth/me, /api/auth/partner-context, and /api/auth/profile. It resolves
memberships, KYC state, permissions, and active organization in one context.

**Status:** CURRENT MOCK / LEGACY-compatible adapter / TARGET replacement.

**Responsibility in production:** subscribe to the supported auth/session
boundary, acquire a real short-lived credential, and pass it to the API client.
The server remains authoritative for identity, membership, approval, KYC, and
permissions.

**Must not own:** arbitrary credential acceptance, token generation, sensitive
ad-hoc localStorage persistence, or permission decisions.

**Disposition:** REPLACE in production; retain only as an isolated test fixture.

### Partner local Next API handlers

Sources: apps/partner-dashboard/src/app/api/auth/**/route.ts and
src/app/api/kyc/**/route.ts.

These handlers return demo JSON. Evidence includes user_demo_123, dummy OTP
123456, auto-approved users, grantedPermissions ['*'], dummy onboarding IDs,
mock custom tokens, and a public Unsplash URL for KYC upload. They do not call a
backend, validate production auth, persist state, or enforce permissions.

Partner login, onboarding, auth provider, and verification screens call them
directly with relative fetch('/api/...').

**Status:** CURRENT local proxy/mock / not production backend integration.

**Responsibility:** none in the production frontend once /api/v2 is authoritative.
They may remain only in an explicitly local UI-only mode.

**Must not own:** accounts, OTP delivery/verification, token minting, KYC
verification, file authority, permission grants, or profile persistence.

**Disposition:** REPLACE with API-client calls to backend /api/v2; then remove or
quarantine the handlers.

### Partner repositories and contracts

Sources: apps/partner-dashboard/src/lib/partner/contracts.ts,
api-partner-repositories.ts, repositories.ts, fixture-host-repository.ts,
fixture-promoter-repository.ts.

contracts.ts defines Host and Promoter repository interfaces and DTO-shaped
models. api-partner-repositories.ts is an injected transport/decoder adapter,
but its endpoints are /api/v1/partner/... and it is not bound at runtime.
repositories.ts binds both runtime repositories to fixtures.

Partner pages consume the composition root for overview, events, event details,
partners, links, finance, profiles, and network profiles.

**Status:** CURRENT interfaces and fixture composition; API adapter PARTIAL;
the /api/v1 paths are LEGACY relative to target /api/v2.

**Responsibility:** page-facing repositories should call the shared client,
decode backend DTOs, and expose typed loading/error behavior.

**Must not own:** direct Firestore, backend business calculations, fabricated
metrics, payment settlement, or authorization.

**Disposition:** RETAIN contracts and adapter shape; REPAIR paths, transport, and
decoders; switch composition to API repositories behind an explicit integration
gate.

### Partner fixtures

Sources: fixture-host-repository.ts and fixture-promoter-repository.ts.

These contain hard-coded profiles, events, ticket sales, finance summaries,
relationships, tracking links, and analytics. They are the runtime binding.

**Status:** CURRENT FIXTURE.

**Responsibility:** deterministic tests and local visual development.

**Must not own:** live event state, availability, ticket counts, financial
amounts, attribution, or fallback after a backend error.

**Disposition:** RETAIN for tests/local preview; remove from production data paths.

### Guest Portal feature fixtures

Sources: apps/guest-portal/src/features/**/fixtures/*.ts and route pages under
apps/guest-portal/src/app. The existing handoff document at
apps/guest-portal/docs/frontend-backend-handoff.md also states the UI is
fixture-backed.

Fixtures drive home, explore, event detail, checkout, confirmation, tickets,
profile, login, directory, host, and venue pages.

**Status:** CURRENT FIXTURE / TARGET server loaders plus API client.

**Responsibility:** fixtures are stable preview/test data. Production pages must
load public data through the backend, keep private data user-scoped, and
revalidate availability/price at checkout.

**Must not own:** identity, order/ticket authority, QR validity, price,
capacity, inventory, or privacy policy.

**Disposition:** RETAIN fixture types/tests; REPLACE page data sources; prohibit
fixture fallback after an API error.

### Payment and checkout

No tracked frontend Razorpay/Stripe SDK or payment client was found. Guest
checkout and confirmation are presentation routes backed by booking fixtures.
Partner verification has a direct IFSC lookup in verify/PageClient.tsx; it is
not payment processing.

**Status:** MISSING production payment service / FIXTURE checkout UI.

**Responsibility:** use backend checkout/order/payment endpoints. The frontend
may render a provider-hosted checkout or provider client token only after the
backend creates and authorizes the attempt. Payment state must be fetched from
the backend.

**Must not own:** price/inventory decisions, payment verification, webhooks,
signature verification, refunds, settlement, or provider secrets.

**Disposition:** MISSING; implement only against the approved backend contract.
Keep fixture checkout preview-only. Move or mediate the IFSC lookup if needed.

### Storage, media, and uploads

Partner verification imports Firebase Storage helpers and calls
uploadBytesResumable/getDownloadURL, but the local storage adapter returns an
empty object. The local KYC route returns a hard-coded public image URL. No
shared upload service was found.

**Status:** CURRENT UI attempt / MOCK route / MISSING authoritative upload service.

**Responsibility:** request a scoped upload session or signed upload from the
backend, upload with progress/cancellation, and submit an opaque file ID.
Backend/provider storage owns scanning, retention, access, and deletion.

**Must not own:** public arbitrary URLs, KYC validity, provider credentials, or
trust decisions based on client MIME values.

**Disposition:** REPLACE with the backend-issued upload workflow.

### Notifications, realtime, and polling

Notification screens/models exist in Partner Dashboard, but no FCM client,
push-registration service, WebSocket, EventSource, or shared polling service
was found.

**Status:** MISSING service; CURRENT presentation surfaces only.

**Responsibility:** use backend-owned notification records and approved
provider/realtime boundaries. Device tokens and subscriptions must be scoped and
authenticated. Polling must be bounded, abortable, visibility-aware, and
cursor/version based.

**Must not own:** delivery guarantees, unread truth, fan-out, provider secrets,
or cross-user streams.

**Disposition:** MISSING; add only with backend and mobile/scanner ownership defined.

### Analytics and tracking

Partner repository models and fixtures include analytics summaries, trends,
attribution, and tracking links. UI helpers copy generated links to the
clipboard. No shared analytics SDK or transport was found.

**Status:** FIXTURE data and UI actions / MISSING production analytics service.

**Responsibility:** send privacy-reviewed product events through a typed client or
backend endpoint with consent and redaction. The backend computes authoritative
sales, attribution, finance, and reporting metrics.

**Must not own:** revenue, ticket conversion, attribution settlement, or
unapproved PII collection.

**Disposition:** RETAIN display models; replace fixture metrics with backend DTOs;
add tracking only after an approved event taxonomy and privacy boundary.

### Browser storage, clipboard, and share helpers

Partner mock auth persists its fake session in localStorage. Partner shell stores
partner:last-route:<membershipId>; organization selection uses the same route
memory. Promoter and event marketing components call navigator.clipboard.
There is no shared storage/clipboard service.

**Status:** CURRENT ad-hoc helpers / MOCK auth persistence.

**Responsibility:** store only non-sensitive UI preferences and navigation hints.
Clipboard/share is best-effort and must show failure when unavailable.

**Must not own:** access tokens, session authority, permissions, membership, or
payment state.

**Disposition:** RETAIN route preference if useful; remove mock session
persistence with real auth.

### Cache, loading, retry, and providers

Source: packages/providers/src/query-provider.tsx.

A QueryClient is created per provider instance. Defaults are one-minute stale
time, five-minute garbage collection, no focus refetch, two query retries, and
no mutation retries. The file contains a local isApiClientError that always
returns false, so its intended error-aware retry policy is not active.

**Status:** CURRENT provider / PARTIAL error policy.

**Responsibility:** keep server state in query/cache primitives, key it by user and
active organization, invalidate after mutations, avoid cross-request leaks, and
classify retries using the shared client error type.

**Must not own:** domain authority, cross-user cache sharing, fixture fallback,
or automatic retries for non-idempotent mutations.

**Disposition:** RETAIN provider; connect it to the shared client and review
endpoint/session-specific cache values.

### Feature flags

No dedicated feature-flag service or tracked flag provider was found.
Environment configuration exposes an environment name but not remote flag
evaluation.

**Status:** MISSING.

**Responsibility:** if required, use typed, audited, server-controlled rollout
values with safe defaults. Frontend flags may control presentation/rollout only.

**Must not own:** authorization, payment enablement, or security controls.

**Disposition:** MISSING; do not infer security-sensitive flags from URL or storage.

## Cross-cutting production rules

### Errors

The API client should normalize transport failures into ApiError, preserving
status, requestId, and field errors. Render distinct states for anonymous,
forbidden, not found, validation/conflict, unavailable, and unexpected failures.
A production request failure must not render a fixture as live data.

### Authentication and authorization

The frontend may hold a session handle and display server-provided capability
state. Backend services must resolve user, active organization, membership, role,
approval, KYC status, and permission. Client checks are usability gates only.

### Loading and cancellation

Every server read needs an explicit pending state. Abort route-obsolete reads
and long uploads. Do not show demo names, fabricated zeroes, or previous-user
data while a new organization/session is loading.

### Caching and invalidation

Public discovery data may use bounded revalidation when permitted by contract.
Profile, wallet, checkout, confirmation, finance, KYC, and permission data are
user/organization scoped. Availability, price, inventory, and payment status
must be revalidated at the backend mutation boundary.

### Retries

Retry idempotent network/timeouts with bounded policy and request correlation.
Do not retry validation, unauthorized, forbidden, not-found, or conflict. Do
not retry mutations unless explicitly idempotent and protected appropriately.

### Observability and privacy

Use request IDs in support/logging without logging tokens, OTPs, payment data,
raw QR secrets, or unnecessary PII. Any Sentry/analytics integration must
redact errors and respect consent/environment boundaries.

## Migration order

1. Verify /api/v2 DTOs and error envelopes against the backend.
2. Implement the shared api-client transport and decoders.
3. Connect session bootstrap/token handling and remove mock auth from production.
4. Convert Partner repository composition from fixtures to API repositories.
5. Convert Guest server loaders and private ticket/profile flows.
6. Replace local Partner auth/KYC handlers with backend calls, then remove them.
7. Add checkout, uploads, notifications, and analytics only with contracts.
8. Audit mobile and scanner in authoritative worktrees and align their authority.

## Evidence and limitations

- git ls-remote frontend refs/heads/staging returned the audited HEAD on
  2026-08-20. This is repository evidence, not a commit or push.
- The checkout is dirty with unrelated tracked modifications and many untracked
  nested/recovery directories. None were edited or treated as canonical source.
- No tracked mobile or scanner files were returned by git ls-files for their
  app/source patterns. Their inventory requires separate authoritative worktrees.
- This document does not claim backend routes, provider connectivity, real auth,
  Firestore data, payment success, push delivery, or physical-device behavior.

## Primary source map

| Area | Source |
| --- | --- |
| Shared client/auth/config/providers/types | packages/api-client/index.ts; packages/auth/index.ts; packages/config/src/env.ts and schema.ts; packages/providers/src/query-provider.tsx; packages/types/src/api.ts |
| Partner composition/repositories | apps/partner-dashboard/src/lib/partner/repositories.ts; contracts.ts; api-partner-repositories.ts; fixture repositories |
| Partner mock auth | apps/partner-dashboard/src/lib/firebase/client.ts; components/providers/DashboardAuthProvider.tsx |
| Partner local handlers | apps/partner-dashboard/src/app/api/auth/**/route.ts; src/app/api/kyc/**/route.ts |
| Guest fixture-backed pages | apps/guest-portal/src/features/**/fixtures/*.ts; apps/guest-portal/src/app |
| Guest handoff boundary | apps/guest-portal/docs/frontend-backend-handoff.md |
| Architectural guardrails | packages/eslint-config/src/base.ts; constants.ts; next.ts; react.ts |
