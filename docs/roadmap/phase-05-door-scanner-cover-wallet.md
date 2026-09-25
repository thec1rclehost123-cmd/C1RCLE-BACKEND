# Phase 5 — Door / Scanner / Cover-wallet

**Status:** done, hardened 2026-09-11 — 1 honest 501 remains (`/door/stats/ws`, needs `@fastify/websocket`). The offline manifest is now real. See the 2026-09-11 session log for the six security findings closed. · **Depends on:** Phase 4 (entitlements must exist)

## v1 proven logic to port (`thec1rcle`)

- **Entitlement scan system** (`entitlement-engine.js`) — the current,
  non-deprecated ticket verification path (legacy static-QR system in
  `scan-engine.js` is `@deprecated`, do not port). State machine
  `ISSUED → ACTIVE → CONSUMED` (terminal) / `REVOKED` / `EXPIRED`.
  **"Magic Ticket" rotating QR** for tickets ≥ ₹5000:
  `HMAC(entitlementId : floor(unixTime/30))` — rotates every 30s, screenshot
  useless within half a minute; verify checks current + previous window
  (±65s clock-drift tolerance).
- **`processEntryScan`**: transactional — verify signature/freshness → load
  entitlement → check eventId match → check not already consumed/over
  scan-count → write `scan_ledger` (DENIED with reason or CONSUMED) →
  increment `scanCountUsed`.
- **Scanner session auth** (separate from guest auth): `event_codes/{code}`
  doc (`type: full|scan_only|charge`, optional gate, expiry, revocable) →
  session token scoped to that event/code/gate for the shift. Permissions by
  type: `full→scan+doorEntry+walkIn`, `scan_only→scan+walkIn`, `charge→cover-wallet only`.
- **Door entry (walk-up sale)**: price **always recalculated server-side**
  from the event's ticket catalog, never trusted from client (explicit v1
  security rule — port this exactly). Synthetic order doc, idempotent via
  client-supplied idempotency key.
- **Walk-ins/dine-in** (headcount, no ticket): `door_sales` collection,
  `category: walkin|dinein`, `paymentMode:'cash'`.
- **Live scanner stats**: real-time aggregate (`totalEntered, checkedIn,
  doorEntries, doorRevenue, walkIns, entryTypeCounts`), pushed over
  WebSocket to the venue dashboard so door-count updates without polling.
- **Cover-charge wallet engine** (`cover-charge-engine.js`, 1049 lines — the
  most complex single v1 module): prepaid digital wallet issued per cover-
  charge ticket. Hard invariants to port verbatim: all amounts integer paise;
  every mutation has a caller idempotency key; Firestore transactions for
  balance+txn atomicity; velocity limit (max 3 debits/min/device); terminated
  wallets reject all mutations; offline debits blocked at API layer.
  **Nightlife-specific termination time**: `computeTerminationTime(eventStartIso,
  terminationHour=5, tzOffset='+05:30')` — if event starts before the cutoff
  hour it terminates same calendar day, else next calendar day (handles
  "night doesn't end at midnight").

## Firestore collections

`v2_scan_ledger`, `v2_event_codes`, `v2_scanner_sessions`, `v2_door_sales`,
`v2_cover_wallets` (+ `txns` subcollection), `v2_cover_wallet_reconciliations`.

## ⚠️ Known v1 security note (do not blindly copy)

`PAYMENT_TICKET_CODE_REVIEW.md` (in `thec1rcle`) documents an earlier bug
where a scanner-session endpoint trusted `{eventId, venueId, userId, role}`
straight from the request body with no re-verification — spoofable. Fix
pattern: staff-login issues a short-lived signed token; `/staff/session`
verifies that token rather than trusting body fields. Verify the *current*
`thec1rcle` code before assuming this is fixed there — the review doc flags
it as a past finding, not a guaranteed-current state.

## Execution plan

Superseded by `docs/PHASE_5_HTTP_WIRING_PLAN.md` — that doc is the current,
accurate breakdown of what shipped and what remains. (An older pre-implementation
"Execution Plan (Agent-driven)" section lived here inline; it had been duplicated
into the file as a line-number-prefixed paste and was removed 2026-09-01.)

## Session Log

### 2026-08-21 — HTTP wiring session

Prior state at session start: domain models / ports / services / memory +
Firestore adapters / contracts all existed and were wired into `v2-services.ts`,
but every route in `phase5-routes.ts` returned `501` regardless (confirmed by
reading the file directly — this contradicted an uncommitted `ROADMAP.md` edit
claiming "done … 29/29 contract tests pass", which was never actually true until
this session).

What changed: split the routes into `door/scanner-routes.ts` (sessions,
check-ins, verify, lookup, offline-sync, magic QR — override and offline-manifest
stay honest 501s, see below), `door/door-sale-routes.ts` (walk-in/dine-in/sales,
server-side price recalc confirmed against `door-service.ts`),
`door/cover-wallet-routes.ts` (issue/get/debit/credit/terminate/reconcile —
freeze/unfreeze stay 501, no service method exists). `phase5-routes.ts` now holds
only the two genuinely-deferred routes (`/door/stats`, `/door/stats/ws` — no
`@fastify/websocket` registered, no aggregation design).

Also fixed, all pre-existing and blocking (found while getting this to actually
run, not introduced by the routing work): `packages/core`'s
`infrastructure/utils.ts` didn't compile; `buildActorContext` had no
memory-driver fabrication path, 401/500-ing ~95 of 122 gateway tests;
`contract-suite.test.ts` imported `MemoryCoverWalletReconciliationRepository`
from the wrong file (the test had never actually run — "29/29" was aspirational);
reconciliation ids embedded a full eventId and blew the 64-char id cap;
`runReconciliation` double-counted the opening balance.

Verified: `pnpm --filter @c1rcle/core build` clean, gateway typecheck clean,
`pnpm --filter api-gateway exec vitest run` → 122/122. Core was reported here as
231/232 with `compare-and-set.test.ts` failing — **that measurement was on the
uncommitted tree; see the 2026-09-01 entry, it is now 232/232.**

Still open, by design (see `docs/PHASE_5_HTTP_WIRING_PLAN.md`): live door stats
+ WebSocket, `/door/override` (FSM has no `denied → overridden` transition),
`/door/offline-manifest` (nothing signs one), cover-wallet freeze/unfreeze (no
service method), a real scanner-device bearer-token auth layer (routes currently
authenticate via cookie session like every other v2 route). Also unresolved,
found but out of scope here: `ScannerSession.organizationId` is set to the
creating actor's id, not the real org (worked around at the route layer);
`scanTicket`/`scanMagicTicket` read the client's `deviceId` field as a
session-token lookup key, not a hardware id.

### 2026-09-07 — Phase 5 completion: override, stats, freeze/unfreeze, domain tests

Committed `0342d80` (door override), `53727c8` (door stats read model),
`2ec1e61` (cover-wallet freeze/unfreeze), `3f48069` (5 domain-model unit test
files: `scan-ledger.test.ts`, `event-code.test.ts`, `door-sale.test.ts`,
`cover-wallet.test.ts`, `cover-wallet-reconciliation.test.ts`).

Phase 5 now has 2 honest 501s by design:
1. `GET /door/stats/ws` — needs `@fastify/websocket` registered on the app
2. Scanner QR manifest-signing (`scanner-routes.ts:422`) — no signing service
   exists; correctly documented at the call site

### 2026-09-01 — doc reconciliation

- The "core 231/232, 1 known failure = `compare-and-set.test.ts`" claim is
  **stale**. `pnpm --filter @c1rcle/core test` is **232/232** and has been green
  since the recovery commit `7e2d6c9`. The 231/232 was measured on the
  uncommitted pre-recovery tree, never on a commit.
- Removed the duplicated line-number-prefixed paste of an older version of this
  file (the whole "Execution Plan (Agent-driven)" + "Security Checklist" block
  with `NN:` prefixes and a second `**Status:** not started` line).
- **Still to do for Phase 5 (as of 2026-09-01):** the 6 honest 501s (Founder
  Tasks A2 + B1 + B2), and **5 domain-model unit test files**. **All completed
  as of 2026-09-07** — see session log entry above. Only 2 honest 501s remain
  (stats/ws, scanner manifest-signing).

### 2026-09-11 — Scanner hardening: the door is now safe for multiple clubs

Phase 5 was wired but not deployable in front of real venues. Six findings,
all closed this session; full reasoning in `docs/architecture/decisions.md`
D-025, and a plain-language account in
`docs/Sagar_code_Changes/WORK-DONE-BY-SAGAR-2026-09-11.md`.

**What was wrong, and what it now does:**

1. **No way to authorize a scanner.** `createEventCode` was registered on no
   route. New `door/event-code-routes.ts`: `POST|GET /events/:eventId/door-codes`,
   `POST /door-codes/:codeId/revoke`, `GET /door-codes/:codeId/sessions`,
   `POST /door/sessions/:sessionId/revoke` — all under a new `door.manage`
   RBAC permission (owner/admin/manager). Revoking a code also revokes every
   live session it opened.
2. **Device identity was a body field.** Scans now require
   `X-Scanner-Session-Token` (minted once by `POST /door/sessions`, stored
   only as a SHA-256 hash). `scannedBy`/`deviceId` are gone from the wire;
   the ledger's operator is the authenticated actor.
3. **The entitlement was never spent.** `scanTicket` read but never wrote, so
   `scanCount` stayed 0 and a couple ticket was refused on its second guest.
   Admission now goes through `EntitlementRepository.claimAdmission`.
4. **Two scanners could both be admitted.** `claimAdmission` is one Firestore
   `runTransaction` (memory adapter: no `await` between read and write).
   Pinned by a concurrency test.
5. **Rotating QRs were signed with a published constant.** `MAGIC_TICKET_SECRET`
   is wired through and is a production boot requirement (32+ chars); HMACs
   compare with `timingSafeEqual`; stale windows are refused as replays.
6. **`Math.random()` credentials, raw token at rest.** Door codes and session
   tokens are CSPRNG (codes use an unambiguous alphabet staff can read in a
   dark room), and the raw token never touches the stored entity.

**Also fixed:** the scan-ledger id derived from `Date.now()` alone, so two
scans of one ticket inside a millisecond collided and door staff saw a 409 on
an ordinary second scan; the check-in detail DTO omitted `overridden` and
500'd when reading back an overridden scan; previews reported `consumed`,
which reads as "admitted", when nothing had been consumed.

**New:** `GET /door/offline-manifest` is real (signed, and the sync path
verifies), `SCANNER_COMMAND` rate class (300/min — a club door genuinely
scans faster than `STANDARD_COMMAND` allows), `X-Scanner-Session-Token` added
to the pino redaction list.

**Still open, deliberately:** `GET /door/stats/ws` (no `@fastify/websocket`);
an override does not credit a scan back to the ticket.

**Verified:** `pnpm check` fully green — format, lint, typecheck, boundaries,
825 tests (core 470, gateway 342, contracts 13) + 2 end-to-end scenarios,
build.

### 2026-09-15 — Scanner-app backend: devices, shift start, couple flow, roster

Built the rest of the dedicated door app's backend (the 11 Sep entry covered
the admission path's security). Full reasoning in
`docs/architecture/decisions.md` D-026; plain-language account in
`docs/Sagar_code_Changes/WORK-DONE-BY-SAGAR-2026-09-15.md`.

**Built:**
- **Bound devices** — `ScannerDevice` aggregate (`v2_scanner_devices`, keyed
  `${organizationId}_${deviceId}`) + ports + memory/Firestore adapters. A scan
  now requires a bound, active handset in addition to a valid session token,
  so unbinding a lost phone stops it on the very next scan. Unbinding also
  closes that handset's live sessions. Routes: `POST|GET /door/devices`,
  `POST /door/devices/:deviceId/unbind`, `POST /door/heartbeat`.
- **Event picker + one-call shift start** — `GET /door/events?date=today`
  (IST-resolved, drafts/cancelled hidden, org-scoped) and an enriched
  `POST /door/sessions` returning session + event + tiers + gate + opening
  stats. New `DoorOpsService` composes scanner + stats + catalog so routes
  stay one call.
- **Couple tickets, two-step** — an untouched `scanCountAllowed: 2` ticket
  returns `confirmation_required` with a 30s signed token bound to ticket +
  event + session + device + expected scan count, writing nothing.
  `POST /door/check-ins/confirm` then takes **both seats in one claim**
  (`claimAdmission({ seats, expectedScansUsed })`), or records a real denial
  on "no".
- **Staff deny** (`POST /door/staff-deny`) — records the refusal, does NOT
  consume the ticket.
- **Guest roster + manual check-in** — `GET /door/guests` merges entitlements
  with door sales (entered-ness read from the ticket, not the ledger);
  `POST /door/guests/check-in` runs the same atomic claim as the camera.
- **Real occupancy** — `Event.capacity` (nullable — no fabricated default) and
  a `sum(admittedCount)` aggregate, because a confirmed couple row admits two
  and a denial admits nobody.
- **Server-side door-guest validation** — 10-digit phone, 18+, enumerated
  gender, real email. These rules previously existed only in the app's submit
  button.

**Also:** `DeviceNotAuthorizedError` (403, never masked as 404 — door staff
need to be told the handset is deauthorized, and there is nothing to hide
from a caller who already proved tenancy and a live session).

**NOT built, tracked not hidden:** Cover-Wallet charging on the Scan tab
(wallet-QR recognition + preset items + charge-by-item — the wallet itself
exists, the scanner-facing surface does not); the paid walk-up ticket sale
(tier + quantity + payment creating a real order/tickets/ledger trail);
`GET /door/stats/ws` (still an honest 501, needs `@fastify/websocket`) and the
realtime dashboard broadcast that depends on it.

**Verified:** `pnpm check` fully green — 873 tests (core 488, gateway 372,
contracts 13) + 2 end-to-end scenarios.

### 2026-09-15 (part 2) — Door commerce: cover-wallet tabs + paid walk-up sale

The two remaining items from the scanner app's feature list. Reasoning in
`docs/architecture/decisions.md` D-027.

**Cover wallet on the Scan tab:**
- `CoverWalletRules` on the wallet — the venue's preset item list
  (`{id, label, amountPaise, isAvailable}`), min/max charge bounds, and a
  `showBalanceToGuest` switch. `priceForCharge`/`findChargeableItem` are pure
  and fail closed.
- Rotating tab QR (`cw:<walletId>:<window>:<hmac>`, 30s, same key as ticket
  QRs under a `wallet:` purpose prefix). Guest-facing mint:
  `GET /cover-wallets/:walletId/qr`.
- `POST /door/wallet-qr` — scanner reads a tab: first name, balance, available
  items. Requires a `charge`-type session.
- `POST /door/wallet-charge` — charges one preset item by id + quantity. The
  amount is never on the wire. Idempotent, velocity-limited (existing 3/min
  per device), refuses frozen/insufficient tabs without partial effect.

**Paid walk-up ticket sale** — `POST /door/ticket-sale`, new
`DoorTicketSaleService`:
- price recalculated from the tier (no amount field exists on the wire)
- inventory checked first — the door will not oversell
- creates a real paid order walking `pending → awaiting_payment → paid`,
  issues tickets, admits each through the same atomic claim as a camera scan,
  and settles via `CheckoutService.settleOrder` (made public — one writer for
  all revenue, not two)
- cash sale carries no gateway fee/GST-on-fees; face value is the total
- order id derived from the idempotency key, so a retry replays instead of
  charging twice
- requires a `full` (door-entry) session — selling entry is a stronger right
  than scanning it

**Verified:** `pnpm check` green — 893 tests (core 488, gateway 392,
contracts 13) + 2 end-to-end scenarios.

**Phase 5 scanner scope is now complete.**

### 2026-09-15 (part 3) — Live stats push + security review

**Live push shipped as Server-Sent Events**, not WebSocket — see D-028 for the
full reasoning (one-way data; SSE inherits the existing auth/CORS/rate-limit
controls instead of needing a token in a query string; correct on more than
one instance with no Redis fan-out). `GET /door/stats/stream` with a per-actor
and global connection budget, authorization before the first byte,
re-authorization every tick, a 15-minute lifetime cap, heartbeats inside
nginx's idle timeout, and close-on-backpressure. nginx gained a matching
`proxy_buffering off` location. `GET /door/stats/ws` is now **absent** rather
than a 501, per D-006.

**Security review of the whole scanner surface** —
`docs/architecture/scanner-threat-model.md`. Two real holes found and fixed
(D-029):
1. `POST /door/devices` reactivated unbound handsets, so a manager's
   revocation of a stolen phone could be walked back by anyone. Reactivation
   is now its own `door.manage` route.
2. Venue staff could mint a guest's cover-wallet QR, and therefore charge a
   tab with the guest absent. Now owner-only.

Two scale/correctness fixes in the same pass: the guest roster no longer pages
an entire festival's entitlements into memory (bounded, server-side filtering,
honest `truncated` flag), and the admissions breakdown is exact at any scale
(one `sum()` aggregate per tier) rather than sampling 5,000 rows and silently
understating categories.

**Verified:** `pnpm check` green — 906 tests (core 488, gateway 405, contracts
13) + 2 end-to-end scenarios, boundaries clean.
