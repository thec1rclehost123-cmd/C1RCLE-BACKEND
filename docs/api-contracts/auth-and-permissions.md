# Authentication and permissions contract

**Status:** corrected 2026-08-29 against the live backend. An earlier draft
described a single `GET /api/v2/session` returning `{ user, memberships,
permissions }` wrapped in `{ data, meta }`. The gateway does not have that
route or that shape. See `docs/architecture/decisions.md` D-001 and D-024, and
`C1RCLE-FRONTEND/docs/superpowers/specs/2026-08-27-frontend-gateway-auth-foundation-design.md` §2.
**Authority:** `apps/api-gateway/src/routes/v2/auth/index.ts`,
`packages/contracts/src/contracts/{auth,partner,organization}.ts`, and their tests.

## Mechanism

Better Auth (D-001): an httpOnly session cookie the backend owns, plus a
short-lived access token the client holds **in memory only** and sends as
`Authorization: Bearer <token>`. The access token is Better Auth's own session
token (surfaced via the `bearer()` plugin's `set-auth-token` response header) —
not a separately minted JWT. Real auth requires `STORAGE_DRIVER=firestore`
(`STORAGE_DRIVER=memory` is the test/CI sandbox and fabricates a dev actor).

## Routes (live)

| Method | Path | Body | Response | Rate class |
| --- | --- | --- | --- | --- |
| POST | `/api/v2/auth/signup` | `signupRequestSchema` `{ email, password (8–128), displayName }` `.strict()` — **no `role`** | 201 `authBridgeResponseSchema` `{ user, accessToken, expiresAt }` | `SENSITIVE_COMMAND` (10/60s) |
| POST | `/api/v2/auth/login` | `loginRequestSchema` `{ email, password }` `.strict()` | 200 `authBridgeResponseSchema` | `SENSITIVE_COMMAND` |
| POST | `/api/v2/auth/refresh` | none (httpOnly cookie only) | 200 `authBridgeResponseSchema` | `SENSITIVE_COMMAND` |
| POST | `/api/v2/auth/logout` | none | 204 (+ Set-Cookie clear; revokes the server session) | — |
| GET | `/api/v2/auth/session` | none | 200 `sessionSchema` `{ user, expiresAt }` or 401 | `AUTH_READ` (240/60s) |

`user` = `userSchema` `{ id, email, displayName, role: 'guest'|'partner'|'admin',
avatarUrl: string|null }` — **5 fields**. `expiresAt` is **epoch milliseconds**
(`z.number().int().positive()`), unlike every other timestamp on the wire
(ISO-8601 strings). `signup` always sets `role: 'partner'` server-side.

Login failures return one constant body regardless of whether the email exists
(no account-existence oracle).

## What `/auth/session` does NOT return

No `memberships`, no `activeOrganizationId`, no `permissions`, no approval/KYC
state, no `{ data, meta }` wrapper. Those are separate calls:

| Need | Call | Response |
| --- | --- | --- |
| organizations the user belongs to | `GET /api/v2/organizations` | `{ items: organizationDtoSchema[], pageInfo }` |
| effective permissions + tab visibility for one org | `GET /api/v2/organizations/:organizationId/access` | `partnerAccessDtoSchema` |
| onboarding / approval state | `GET /api/v2/onboarding/me` | `{ request: onboardingRequestDtoSchema \| null }` |

`partnerAccessDtoSchema` = `{ organizationId, userId, partnerType:
'venue'|'host'|'promoter', role, permissions: PartnerPermission[],
tabVisibility: Record<string,boolean> | null }`. `null` tabVisibility means
"show all tabs". `PartnerPermission` is an 18-value enum
(`VIEW_FINANCIALS, MANAGE_STAFF, MANAGE_EVENTS, EDIT_EVENT_RULES, MANAGE_TABLES,
VIEW_GUESTLIST, SCAN_ENTRY, LOG_INCIDENTS, VIEW_ANALYTICS, MANAGE_SETTINGS,
MANAGE_PROMOTERS, MANAGE_PAYOUTS, MANAGE_PARTNERSHIPS, MANAGE_PAGE_CONTENT,
VIEW_REAL_TIME_SCANS, MANAGE_GUEST_OPS, CHARGE_COVER_WALLETS, EXPORT_GUESTS`).
There is **no** `actionPermissions`, `piiPolicy`, or `isSuspended` field —
suspension surfaces as a `403` from any org-scoped route.

## Org scoping

Every org-scoped route needs `X-Organization-Id: <opaqueId>` **and** that value
must equal the `:organizationId` path segment. The **path is authoritative**;
a mismatch is `403`. Cache and rate-limit keys derive the org from the verified
actor, never the header. Cross-tenant reads are `403`/`404` with an answer that
is identical whether or not the resource exists.

## Credential rules

- Access token: in memory only. Never `localStorage` / `sessionStorage` /
  `IndexedDB` / a JS-readable cookie / a URL / a query string / a log line.
- The session cookie is httpOnly and backend-owned. The frontend's thin
  Next.js BFF re-scopes it to the frontend origin and owns the CSRF check for
  the cookie-bearing calls (`refresh`, `logout`) — see the design spec §8.
- The API client attaches `Authorization` centrally; pages never build auth
  headers.
- All authorization is the backend's. A visible link or an enabled button is a
  usability hint, not a permission.
