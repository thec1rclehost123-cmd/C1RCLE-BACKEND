# API error contract

**Status:** corrected 2026-08-29 against the live backend (`packages/contracts` +
`apps/api-gateway` tests, ~340 passing). An earlier draft of this file described
a `{ success, error }` / `{ data, meta }` shape from the frozen V2 manifest —
that shape is **not** what the gateway ships. See
`docs/architecture/decisions.md` D-004 and D-009.
**Authority:** `packages/contracts/src/index.ts` (`buildV2ErrorResponse`,
`STATUS_CODE_TO_ERROR_CODE`, `zodToFieldErrors`) and the route tests. This
document explains; it does not override.

## Success envelope

There is **no wrapper**. A success response is the bare DTO, validated against
its zod schema in `packages/contracts`:

~~~jsonc
// GET /api/v2/organizations/:id  -> organizationDtoSchema
{ "id": "org_1", "name": "…", "slug": "…", "role": "owner",
  "status": "active", "version": 3, "createdAt": "…", "updatedAt": "…" }
~~~

Lists are `{ items, pageInfo }` (page-based):

~~~jsonc
{ "items": [ /* … */ ],
  "pageInfo": { "page": 1, "pageSize": 20, "total": 42, "hasNextPage": true } }
~~~

`204 No Content` has no body (the client's `noContentSchema` handles it).

## Error envelope

**Flat, from every path** — 404s, unhandled 5xx, validation, all of it:

~~~jsonc
{ "code": "validation",        // ApiErrorCode, lowercase
  "message": "…",              // human-safe; 5xx is always "Internal server error"
  "status": 422,               // the HTTP status, echoed in the body
  "requestId": "uuid",         // echo of x-request-id, or a minted UUID
  "fieldErrors": {             // present only for 400/422
    "profile.phone": ["Must be 6–20 characters."]
  } }
~~~

`ApiErrorCode` (the only values that ever appear in `code`):
`validation | unauthorized | forbidden | not_found | conflict | rate_limited |
server | network | timeout | aborted | parse | unknown`.
(`network`/`timeout`/`aborted`/`parse`/`unknown` are produced client-side by
`@c1rcle/api-client`, never sent by the gateway.)

## Status → code → frontend behavior

| HTTP | `code` | Frontend behavior | Retry |
| ---: | --- | --- | --- |
| 400 / 422 | `validation` | Map `fieldErrors` to fields; else a form-level message | No |
| 401 | `unauthorized` | One `refresh()` via `@c1rcle/api-client`'s `reauth`, replay once, else clear session + `/login` | One refresh only |
| 403 | `forbidden` | Permission-denied state — **identical whether or not the resource exists** (IDOR-safe) | No |
| 404 | `not_found` | Not-found state | No |
| 409 | `conflict` | Version conflict → refetch + resubmit with the new `version`; idempotency conflict → treat as already-done | No automatic mutation retry |
| 429 | `rate_limited` | Honor `Retry-After` (seconds); bounded delayed retry | Bounded, idempotent only |
| ≥500 | `server` | Generic "something went wrong" + request ID; internals are already stripped server-side | Reads only, bounded |

## Request correlation

- Client sends `x-request-id` (a UUID, minted per attempt by `@c1rcle/api-client`);
  the gateway echoes it or mints one.
- `requestId` is in every response body, success and error.
- Never log `authorization`, `cookie`, `x-api-key`, tokens, OTPs, provider
  signatures, payment secrets, QR payloads, or unnecessary PII. The gateway's
  pino `redact` list covers the server side; the frontend BFF must not log
  request/response bodies at all.

## Client normalization (`@c1rcle/api-client`)

`ApiClientError` preserves `code`, `status`, `requestId`, `fieldErrors`. Transport
failures become `network` (no response), `timeout` (client deadline), `aborted`
(cancellation), `parse` (bad JSON or a DTO that fails its zod schema — usually
means the two repos' contracts drifted). `isRetryable` = `network | timeout |
rate_limited`, plus `server` when `status !== 501`.

## Fallback rule

A production API error never renders a fixture, a demo identity, zero-valued
metrics, or another user/org's cached data. Fixtures are for tests and an
explicitly labelled local preview mode only.

## Backend acceptance (already met on the auth/partner/onboarding/door surface)

- One flat error envelope from every path, including `setNotFoundHandler` (D-009).
- `code` is a lowercase `ApiErrorCode`; the status→code map is single-sourced in
  `packages/contracts`.
- `requestId` present everywhere; `fieldErrors` on 400/422 via `zodToFieldErrors`.
- 401/403/404/409/422 behavior covered by route tests.
- `Retry-After` on 429 (`plugins/rate-limit.ts`).
- 5xx bodies say only "Internal server error"; the real message is logged with
  the `requestId`.
