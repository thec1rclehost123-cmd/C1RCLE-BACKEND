# API error contract

**Status:** frontend integration contract draft
**Authority:** backend response schemas and tests supersede this document.

## Envelope

Every non-2xx API response must be JSON:

~~~json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request could not be accepted.",
    "details": [
      { "path": "lines[0].quantity", "message": "Must be at least 1." }
    ],
    "requestId": "uuid"
  }
}
~~~

Success responses use:

~~~json
{
  "data": {},
  "meta": {
    "requestId": "uuid",
    "nextCursor": null
  }
}
~~~

The frontend must never depend on raw Firestore fields, provider payloads, stack
traces, or framework-specific error shapes.

## Required codes

| HTTP | Code | Frontend behavior | Retry |
| ---: | --- | --- | --- |
| 400 | INVALID_REQUEST | Show generic request error; log request ID | No |
| 401 | UNAUTHENTICATED / SESSION_REVOKED | Clear stale session, attempt one session refresh, then redirect/sign in | One refresh only |
| 403 | PERMISSION_REQUIRED | Show permission-denied state | No |
| 404 | RESOURCE_NOT_FOUND | Render not-found state | No |
| 409 | VERSION_CONFLICT / IDEMPOTENCY_CONFLICT / INVENTORY_UNAVAILABLE / RESERVATION_EXPIRED | Refresh authoritative state and ask user to retry | No automatic mutation retry |
| 422 | VALIDATION_FAILED | Map details to fields or form summary | No |
| 429 | RATE_LIMITED | Respect Retry-After; show delayed retry | Bounded |
| 502/503/504 | DEPENDENCY_UNAVAILABLE | Show unavailable state and retry action | Idempotent reads only |
| 500 | INTERNAL_ERROR | Show generic error and request ID | Reads only, bounded |

Domain codes may expand, but each must map to one of these frontend behaviors.

## Request correlation

- Client sends X-Request-Id when it has one; backend accepts or generates a UUID.
- Backend returns requestId on success and failure.
- UI support/error reporting may show the request ID.
- Never log Authorization, cookies, OTPs, provider signatures, payment secrets,
  QR secrets, or unnecessary PII.

## Validation details

details is optional. Each detail has a stable path and human-safe message.
The API client converts it to fieldErrors without changing the original code.
Unknown details remain available for diagnostics but are not rendered blindly.

## Client normalization

The shared API client maps transport failures to the frontend ApiError types:

- network: no response
- timeout: client deadline exceeded
- aborted: route/user cancellation
- parse: invalid JSON or invalid DTO
- unauthorized, forbidden, not_found, conflict, validation, rate_limited,
  server: mapped from HTTP/code
- unknown: anything else

The client must preserve status, code, message, request ID, and field errors.

## Fallback rule

Production API errors never fall back to fixtures, demo identities, zero-valued
metrics, or cached data from another user or organization. Fixture fallback is
allowed only in an explicitly labelled local preview/test mode.

## Backend acceptance checklist

- All errors use the envelope.
- Error codes are stable and documented.
- Request IDs are present.
- Validation paths are deterministic.
- 401/403/404/409/422 behavior is covered by contract tests.
- Retry-After is present for rate limiting where applicable.
- Sensitive provider/internal details are redacted.
