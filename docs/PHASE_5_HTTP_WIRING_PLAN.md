# Phase 5 HTTP wiring plan (2026-08-21)

> **Partially superseded (2026-09-07).** Points 3 (freeze/unfreeze = 501),
> Builder B's stats stub, and the override/offline-manifest 501s have been
> implemented in commits `0342d80`, `53727c8`, `2ec1e61`. Only 2 honest 501s
> remain: `/door/stats/ws` (needs `@fastify/websocket`) and scanner
> manifest-signing. Kept as the original wiring plan reference.

Supersedes `docs/phase-05-implementation-plan.md` (untracked draft — written as
if 5A/5B didn't exist yet; they do, see below). Domain models, repository
ports, memory + Firestore adapters, application services, and Phase 5
contracts are ALL already built and wired into `v2-services.ts`. Verified
directly against source, not against docs:

- `packages/core/src/domain/models/{scan-ledger,event-code,door-sale,cover-wallet,cover-wallet-reconciliation}.ts` — exist
- `packages/core/src/infrastructure/memory/memory-{scan-ledger,event-code,door-sale,cover-wallet,cover-wallet-reconciliation}-repository.ts` — exist
- `packages/core/src/infrastructure/firestore/firestore-{scan-ledger,event-code,door-sale,cover-wallet}-repository.ts` — exist
- `packages/core/src/application/{scanner,door,cover-wallet}/*-service.ts` — exist, full method sets
- `packages/contracts/src/contracts/phase5.ts` — exists, 258 lines of real zod schemas
- `apps/api-gateway/src/lib/v2-services.ts` — `scanner`/`door`/`coverWallet` services instantiated with real repos (memory or firestore by `STORAGE_DRIVER`), returned on `PartnerV2Services`

**The actual gap:** `apps/api-gateway/src/routes/v2/phase5-routes.ts` — every
one of its 25 handlers ignores the services above and returns `501`. This is
the entire reason the frontend/backend "integration" claim was false. Fixing
this file (+ 1 pre-existing central-error-handler gap it will expose) closes
the backend side of the gap.

## Known non-obvious wiring details (read before coding)

1. **Scanner session creation is two service calls, not one.** Incoming
   `POST /door/sessions` body has a human `code` string; `createScannerSession`
   takes `codeId` (an `EventCode.id`). Resolve via
   `scanner.validateEventCode(codeStr, actor)` first, then
   `scanner.createScannerSession({ codeId: eventCode.id, deviceId, deviceName, sessionType }, actor)`.
2. **QR payload decode ambiguity — investigate, don't guess.** `ScanBody.qrPayload`
   is `string | object`. `scanTicket(input: ScanTicketInput)` wants a resolved
   `entitlementId` directly; `scanMagicTicket(input: ScanMagicTicketInput)` wants
   the raw `qrPayload: string` (HMAC rotating payload, tickets ≥₹5000). The route
   must decide which path a given payload takes. Find the actual encode/decode
   logic (grep Phase 4 entitlement/checkout code for how QR payloads are
   generated — `entitlementId` embedding vs magic-ticket HMAC) before wiring
   `/door/check-ins`, `/door/check-ins/verify`, `/door/lookup`. Do not invent a
   parsing heuristic — this is a scan-security boundary (v1 had a real spoofing
   bug here per `PAYMENT_TICKET_CODE_REVIEW.md`).
3. **Cover-wallet freeze/unfreeze have no service method.** `CoverWalletService`
   has `terminateWallet`/`closeWallet` but no `freeze`/`unfreeze`. Leave those
   two routes as honest 501s with a comment naming the missing service method
   — do not fake the behavior via `terminateWallet`.
4. **Central error-handler gap (pre-existing bug, not introduced here):**
   `apps/api-gateway/src/plugins/error-handler.ts`'s `mapDomainError` only
   maps specific `*NotFoundError` subclasses to 404 — the generic
   `NotFoundError` (`code: 'not_found'`, used throughout Phase 5 services)
   falls through to an unlogged 500. Each route file defines its own
   *local* `mapDomainError(reply, request, resourceId, error, options)`
   copy (see `partner/events.ts:418`) with its own `notFoundCodes` set —
   Phase 5's copy must include `'not_found'` as a first-class branch (not a
   per-resource string), since Phase 5 services throw the generic class.
5. **Auth model:** every other v2 route authenticates via the Better Auth
   session cookie (`services.actor(request)`), including writes. Phase 5
   routes follow the same convention for this pass — no new device-bearer-token
   auth layer is introduced. This means a scanner device still needs a
   logged-in staff cookie session; a separate short-lived device token (the
   phase-05 doc's "D-022 pattern" reference was a misattribution — the real
   D-022 is about Razorpay webhooks, not this) is explicitly OUT of scope
   here and must be called out as a follow-up, not silently solved.
6. **WebSocket `/door/stats/ws` stays out of scope this pass** — needs
   `@fastify/websocket` registration + connection-scoping design not covered
   above. Leave the existing close-on-connect stub, with an honest comment.

## Execution (3 parallel builders, 1 file each — avoids merge conflicts)

- **Builder A — scanner + offline + magic QR**: `/door/sessions` (POST+GET),
  `/door/check-ins`, `/door/check-ins/verify`, `/door/lookup`,
  `/door/check-ins/:checkInId`, `/door/override`, `/door/offline-manifest`,
  `/door/offline-sync`, `/tickets/:ticketId/qr`.
- **Builder B — door sales**: `/door/walk-in`, `/door/dine-in`, `/door/sales`,
  leave `/door/stats` + `/door/stats/ws` as honest stubs (real-time stats
  aggregation across scanner+door+wallet is a separate design task).
- **Builder C — cover wallet**: `/cover-wallets` (POST+GET), debit, credit,
  terminate, reconcile; `freeze`/`unfreeze` stay honest 501s per point 3.

Each builder: reuse `packages/contracts/src/contracts/phase5.ts` schemas via
`fastify.validateV2` (replacing the file's current ad-hoc inline zod schemas
where a contract schema already covers the same shape), follow the
`partner/events.ts` idiom exactly (`services.actor`, `runIdempotent` for
every mutation, `validateV2Response` on the way out, local `mapDomainError`
per point 4), and add a sibling `*.test.ts` using
`test-utils/partner-test-server.ts` the same way `partner/events.test.ts`
does — at minimum one 2xx happy-path + one 4xx (not-found or forbidden) per
route.

## Verification gate (must pass before any status doc is touched)

```
pnpm --filter @c1rcle/api-gateway typecheck
pnpm --filter @c1rcle/api-gateway test -- phase5
pnpm lint
```

Only after these are green does `docs/roadmap/ROADMAP.md` /
`docs/roadmap/phase-05-door-scanner-cover-wallet.md` get updated — and the
update must name exactly what's proven (routes wired + tested) vs what's
still open (WebSocket, device-token auth, QR-decode path once confirmed,
freeze/unfreeze).

## Explicitly NOT in this pass (frontend)

`C1RCLE-FRONTEND`'s `packages/api-client` is a 2-line stub; all 3 apps read
local mocks/fixtures. That's a separate, larger effort (real fetch client +
per-screen de-mock across guest-portal/partner-dashboard/admin-console) —
tracked as a follow-up phase, not attempted in this pass so the backend fix
doesn't get diluted into an even-larger unverified claim.
