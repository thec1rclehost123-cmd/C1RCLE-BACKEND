# Scanner app — backend contract

> **For whoever is building the scanner front end.** This is the complete,
> verified surface the door app talks to. Every path, body and response below
> was read out of the live code, not written from memory.
>
> **Authority:** `packages/contracts/src/contracts/phase5.ts` (zod schemas —
> the single source of truth), `apps/api-gateway/src/routes/v2/door/*`, and
> `apps/api-gateway/src/routes/v2/phase5-routes.ts`. If this document and the
> code ever disagree, **the code wins** — tell the backend and we fix the doc.
>
> **Base URL:** `<gateway>/api/v2` · **Money:** integer paise everywhere ·
> **Timestamps:** ISO-8601 strings (except `Session.expiresAt`, epoch ms).

---

## 1. The two credentials (read this first)

Every call from a door device carries **two** independent credentials. Neither
one alone is sufficient, and the difference is the whole security model:

| Credential | Header | Says | Lifetime |
|---|---|---|---|
| **Staff session** | `Authorization: Bearer <accessToken>` + `X-Organization-Id: <orgId>` | *Who* the operator is and which venue they act for | 7 days (refreshable) |
| **Scanner session** | `X-Scanner-Session-Token: <token>` | *Which device*, on *which shift*, at *which event*, with *which permissions* | 12 hours |

The scanner-session token is returned **exactly once**, by `POST /door/sessions`.
Every later read of that session reports `sessionToken: null`. Store it in
secure storage (Keychain / Keystore — `expo-secure-store`), never in
`AsyncStorage`, and never log it.

**Access token: in memory only.** Never `AsyncStorage`, never a file, never a
log line. The refresh cookie is the durable credential.

### Which calls need which

- `Authorization` + `X-Organization-Id`: **every** call.
- `X-Scanner-Session-Token`: additionally on scanning, wallet and sale calls —
  marked **`+session`** in the tables below.

---

## 2. Error envelope — identical on every path

```jsonc
{
  "code": "not_found",        // validation | unauthorized | forbidden | not_found
                              // | conflict | rate_limited | server
  "message": "…",
  "status": 404,
  "requestId": "…",           // always log this; it is how backend finds your request
  "fieldErrors": { "guestPhone": ["Phone must be exactly 10 digits"] }  // 400/422 only
}
```

**Status handling the app must implement:**

| Status | Meaning at a door | What the app does |
|---|---|---|
| 400 | The action isn't allowed right now (sold out, item unavailable, tab too low) | Show `message` to staff — it is written for them |
| 401 | Staff session expired, **or** the scanner session is invalid/expired/revoked | Refresh once; if that fails, back to login. On a scan, re-open the shift |
| 403 | **This handset is no longer authorized** (unbound by a manager) | Stop scanning. Tell staff to see a manager. Do not retry |
| 404 | Not found — *or* belongs to another venue | Treat as not found. It is never an "exists but forbidden" signal |
| 409 | Conflicting state (e.g. overriding a scan that isn't denied) | Refetch, show `message` |
| 422 | Your request body is malformed | A bug in the app. Log `requestId` |
| 429 | Rate limited | Honour `Retry-After` (seconds), back off |
| ≥500 | Server problem | Generic retry on reads only. Never retry a money call without its original idempotency key |

**404 vs 403 is deliberate:** anything belonging to another venue answers 404,
so the API can't be used to discover that another club's data exists. Don't
treat 404 as "maybe try again with different scoping".

---

## 3. Rate limits

Sliding window, 60 seconds:

| Class | Limit | Applies to |
|---|---|---|
| `SCANNER_COMMAND` | **300/min** | Scanning, lookup, confirm, staff-deny, wallet read/charge, heartbeat |
| `AUTH_READ` | 240/min | Reads: events, stats, guests, session, ticket QR |
| `STANDARD_COMMAND` | 60/min | Device register, offline sync, manual check-in, ticket sale, walk-in/dine-in |
| `SENSITIVE_COMMAND` | **10/min** | Opening a shift, override, unbind, reauthorize, revoke |

`SENSITIVE_COMMAND` being 10/min matters for UX: if a user fat-fingers a door
code repeatedly they *will* get locked out for a minute. Debounce the submit
button and show the `Retry-After` countdown.

---

## 4. Idempotency — mandatory on money

Calls marked **`+idem`** take `idempotencyKey` in the body.

**One key per user intent, NOT per network attempt.** Mint the key when the
user taps the button, and reuse that same key for every retry of that tap. A
new key on retry is a second charge.

```ts
// correct
const key = randomUUID();            // when the user taps "Charge ₹500"
await chargeWithRetries(key);        // same key on every retry

// wrong — this double-bills
await retry(() => charge(randomUUID()));
```

---

## 5. Flow 1 — Log in and start a shift

```
POST /auth/login              → staff session
GET  /door/events?date=today  → tonight's events at this venue
POST /door/devices            → register this handset (first launch only)
POST /door/sessions           → redeem a door code → SCANNER SESSION TOKEN
```

### `POST /auth/login`
```jsonc
// body
{ "email": "…", "password": "…" }
// 200
{ "user": { "id", "email", "displayName", "role", "avatarUrl" },
  "accessToken": "…", "expiresAt": 1789000000000 }   // epoch ms
```

### `GET /door/events?date=today` · `AUTH_READ`
`date` is `today` or `YYYY-MM-DD`. "Today" is resolved in **IST** — a 1am door
is still working the previous night's event. Drafts and cancelled events are
excluded (a shift on either could only ever deny everyone).

```jsonc
{ "items": [ { "id", "title", "slug", "venueId",
               "startAt", "endAt", "status",
               "capacity": 500 } ] }   // capacity nullable — see §9
```

### `POST /door/devices` · `STANDARD_COMMAND`
```jsonc
{ "deviceId": "<opaque, 16-128 chars>", "deviceName": "Gate iPad 1" }   // → 201 ScannerDevice
```
Generate `deviceId` **once** on first launch (`scanner_` + 32 random hex is
fine), store it in secure storage, reuse it forever. Do **not** derive it from
hardware ids.

> If this returns **403**, a manager unbound this handset. Only a manager can
> restore it (`POST /door/devices/:deviceId/reauthorize`). Do not retry.

### `POST /door/sessions` · `SENSITIVE_COMMAND` · **the important one**
```jsonc
// body
{ "eventId": "…", "code": "C1R-ABCD2345",
  "deviceId": "…", "deviceName": "Gate iPad 1",
  "sessionType": "staff" }              // "staff" | "device"
```
Returns **everything needed to run the shift in one call** — a door phone on
club wifi may not get a second round trip:
```jsonc
{
  "sessionId": "…",
  "sessionToken": "scn_…",          // ⚠️ ONLY time you will ever see this
  "sessionExpiresAt": "…",
  "event": { … DoorEventSummary … },
  "permissions": { "canScan": true, "canDoorEntry": true,
                   "canWalkIn": true, "canCharge": false },
  "gate": "north" | null,           // non-null = this device is pinned to a gate
  "tiers": [ { "id", "name", "entryType", "pricePaise", "available" } ],
  "stats": { … DoorStats … },       // opening snapshot, see §9
  "device": { "deviceId", "deviceName" }
}
```

**Drive the UI from `permissions`,** not from a role string:

| Code type | canScan | canDoorEntry | canWalkIn | canCharge |
|---|---|---|---|---|
| `full` | ✅ | ✅ | ✅ | ❌ |
| `scan_only` | ✅ | ❌ | ✅ | ❌ |
| `charge` | ❌ | ❌ | ❌ | ✅ |

Hide tabs the session can't use. The server enforces it regardless — a hidden
button is a usability hint, never a permission.

---

## 6. Flow 2 — Scanning (the Scan tab)

### `POST /door/check-ins` · `SCANNER_COMMAND` **+session** — the real admission
```jsonc
// body
{ "eventId": "…", "qrPayload": "<raw camera string>",
  "operatorName": "Priya",   // optional, display label on the ledger only
  "operatorRole": "door",    // optional
  "gate": "north" }          // optional; ignored if the code pins a gate
```

**Always 200 on a decision.** A refused guest is a normal outcome to render,
not an HTTP error. Three shapes:

```jsonc
// ✅ admitted
{ "status": "consumed", "checkInId": "SCAN-…",
  "entitlement": { "id", "tierId", "tierName", "holderName",
                   "scansUsed": 1, "scansAllowed": 1, "status": "redeemed" } }

// ❌ refused
{ "status": "denied", "checkInId": "SCAN-…",
  "denyReason": "already_used", "denyMessage": "…" }

// ❓ couple ticket — ASK THE HUMAN (see §7). Nothing was consumed.
{ "status": "confirmation_required",
  "confirmation": { "token": "…", "expiresAt": "…", "seats": 2 },
  "entitlement": { … } }
```

**Deny reasons and what staff should see:**

| `denyReason` | Show |
|---|---|
| `already_used` | "Already scanned" — show `scansUsed`/`scansAllowed` |
| `void_ticket` | "Ticket cancelled or refunded" |
| `wrong_event` | "Ticket is for a different event" — **no guest details are returned; don't imply any** |
| `invalid_signature` | "QR not recognised" |
| `expired`, `device_invalid`, `capacity_exceeded`, `wrong_gate`, `offline_expired`, `override_required`, `promoter_not_authorized` | Fall back to `denyMessage` |

**`checkInId` is absent on `confirmation_required`** — nothing was written.
Don't show a success state for it.

### `POST /door/check-ins/verify` and `POST /door/lookup` · **+session**
Same body. **Read-only preview — spends nothing.**
```jsonc
{ "status": "valid" | "invalid", "denyReason": null, "denyMessage": null,
  "entitlement": { … } }
```
Note the different vocabulary (`valid`, not `consumed`) — that is deliberate,
so a preview can never be mistaken for an admission.

### Offline
**Losing connectivity denies entry.** There is no offline queue by design. On
a network failure show a clear "Scanner offline — entry denied until
connectivity returns" and do **not** store the scan to replay later.

(Endpoints `GET /door/offline-manifest` and `POST /door/offline-sync` exist for
venues that opt into pre-authorized offline mode. The standard app does not
use them.)

---

## 7. Flow 3 — Couple tickets (two-step)

A couple ticket admits two people and both must walk through together.
Consuming a seat before staff confirm the second guest is present would strand
that guest outside holding a half-used ticket.

```
scan → "confirmation_required" + token (30s)
     → staff taps YES / NO
     → POST /door/check-ins/confirm
```

### `POST /door/check-ins/confirm` · `SCANNER_COMMAND` **+session**
```jsonc
{ "eventId": "…", "confirmationToken": "<from the scan>",
  "confirmed": true,        // false = only one guest turned up
  "operatorName": "…", "gate": "…" }     // both optional
```
- `confirmed: true` → `{ "status": "consumed", … }`, **both seats** in one
  transaction.
- `confirmed: false` → `{ "status": "denied", … }`, **nothing spent** — the
  pair can come back together.

**UI requirements:**
- Show a visible **30-second countdown**. The token expires hard.
- On expiry, discard it and tell staff to scan again. Do not retry it.
- The token is bound to this ticket, event, session and device — it cannot be
  used on another phone, so don't try to hand it around.

---

## 8. Flow 4 — Cover-wallet tabs (`canCharge` sessions only)

The guest shows a **rotating tab QR** from their own phone. Recognise it
client-side by the `cw:` prefix (a ticket QR has no prefix) to pick the right
network call — but the server verifies the signature regardless.

### `POST /door/wallet-qr` · `SCANNER_COMMAND` **+session**
```jsonc
// body: { "eventId": "…", "qrPayload": "cw:…" }
// 200
{ "walletId": "…", "eventId": "…",
  "guestFirstName": "Priya",        // first name only, by design
  "status": "active",               // active | frozen | terminated | closed
  "balancePaise": 200000,           // ⚠️ NULL when the venue hides balances
  "presetItems": [ { "id": "item_drink", "label": "Drink",
                     "amountPaise": 50000, "isAvailable": true } ],
  "minChargePaise": 1, "maxChargePaise": 5000000 }
```

### `POST /door/wallet-charge` · `SCANNER_COMMAND` **+session +idem**
```jsonc
// body — note: NO amount field. There is no way to send one.
{ "eventId": "…", "qrPayload": "cw:…",
  "presetItemId": "item_drink", "quantity": 1,
  "idempotencyKey": "<uuid, per user tap>" }
// 200
{ "wallet": { … WalletChargeView … },
  "charged": { "itemId", "label", "quantity", "amountPaise" },
  "balancePaise": 150000 }
```

**Build the UI around this:**
- Render buttons **from `presetItems`**. Never a free-amount keypad — the API
  won't accept one.
- Filter out `isAvailable: false` (the server already does).
- If `balancePaise` is `null`, hide the balance entirely; do not show `0`.
- Check balance client-side before charging so staff get an instant "not
  enough left" — but the server is the authority and will refuse anyway.
- Max **3 charges per device per minute**. A 4th returns 400 with a velocity
  message. Space the UI accordingly.
- Re-scan the QR for each charge. The call takes the QR, not a saved wallet id
  — a charge always follows a tab physically presented.

**Not in the scanner, deliberately:** refunds, top-ups, freezes. Those are
supervisor-console actions. Don't build UI for them.

---

## 9. Flow 5 — Door Entry tab (`canDoorEntry` / `canWalkIn`)

### `POST /door/ticket-sale` · `STANDARD_COMMAND` **+session +idem** — paid walk-up
Creates a **real order**: paid order → issued tickets → already admitted →
revenue in the finance ledger.
```jsonc
// body — again, NO price field
{ "eventId": "…", "tierId": "…", "quantity": 2,
  "paymentMode": "cash",              // cash | card | upi | other
  "guestName": "Rahul Verma",
  "guestPhone": "9876543210",         // optional; EXACTLY 10 digits if sent
  "guestEmail": "…",                  // optional; must be a valid address
  "guestAge": 24,                     // optional; 18-120
  "gender": "male",                   // optional; male|female|other|undisclosed
  "gate": "north",                    // optional
  "idempotencyKey": "<uuid>" }
// 201 (or 200 with replayed:true on a retry)
{ "orderId", "amountPaise", "quantity", "paymentMode",
  "ticketIds": [ … ], "checkInIds": [ … ], "replayed": false }
```
- Price comes from the tier. Show `tier.pricePaise × quantity` so staff can
  collect the right cash — but the server recomputes it.
- Check `tier.available` (from the shift payload) before offering a tier.
  Selling past it returns 400 "sold out" / "only N left".
- `replayed: true` means your retry hit the original sale. **Do not charge the
  guest again.**

### `POST /door/walk-in` and `POST /door/dine-in` · **+idem** — headcount entry
For guests who aren't buying a ticket — a party walking up, or a table.

```jsonc
{ "eventId": "…",
  "guestName": "Ada Lovelace",
  "totalGuests": 2,                   // party size — this is what is priced
  "paymentMode": "cash",
  "guestPhone": "9876543210",         // optional, exactly 10 digits
  "guestEmail": "…",                  // optional, valid address
  "guestAge": 24,                     // optional, 18-120
  "gender": "female",                 // optional, enum
  "gate": "north",                    // optional
  "tableNumber": "12",                // dine-in only, optional
  "idempotencyKey": "<uuid>" }
// → 201 DoorSaleResponse
{ "id", "eventId", "category": "walkin" | "dinein",
  "guestName", "totalGuests", "amountPaise",
  "paymentMode", "status": "active", "createdAt" }
```

**There is no `tierId` and no `quantity` here, and sending either is a 422.**
Walk-in and dine-in are headcount entries priced from the event's own walk-in
/ dine-in tier; choosing a tier is what `POST /door/ticket-sale` is for. (Both
fields used to exist on this schema — `tierId` even required — and the server
ignored both. That has been removed rather than documented, because a client
sending a VIP tier and being charged the walk-in price reads like an exploit
even though it is safe.)

### `GET /door/sales?eventId=&category=walkin|dinein&…` · `AUTH_READ`
Tonight's walk-ins / dine-ins. Filters: `category`, `status`, `gate`,
`paymentMode`, `createdBy`, `from`, `to`, `limit`. Returns `{ items, pageInfo }`.

### Client-side validation to mirror
The server enforces all of this; matching it client-side just gives faster
feedback. **10-digit phone**, **18+**, gender from the enum, a real email (`guestEmail`
— the same field name on walk-in, dine-in and ticket sale).
A mismatch returns 422 with `fieldErrors` keyed by field name — map them
straight onto the form.

---

## 10. Flow 6 — Stats tab

### `GET /door/stats?eventId=` · `AUTH_READ`
```jsonc
{
  "eventId": "…",
  "occupancy": {
    "inside": 342,            // people admitted (a couple ticket counts as 2)
    "capacity": 500,          // ⚠️ NULLABLE
    "remaining": 158,         // NULLABLE — null whenever capacity is null
    "prebooked": 300,         // came in on a ticket bought in advance
    "doorEntries": 42         // sold at the door tonight
  },
  "byEntryType": { "Stag Entry": 200, "Couple Entry": 142, "walk-in": 42 },
  "scans": { "total", "consumed", "denied", "pending",
             "revoked", "overridden", "expired", "cancelled" },
  "doorSales": { "count", "grossPaise" },
  "coverWallet": { "activeWallets", "totalBalancePaise",
                   "totalCreditsPaise", "totalDebitsPaise" },
  "generatedAt": "…"
}
```

**`capacity` and `remaining` are nullable.** When null the event has no
configured capacity: show the headcount **with no limit, no bar, no
percentage**. Do not substitute a default — the old app hardcoded 500 and told
staff a confident number nobody had set.

Fill-bar colours (when capacity exists): green < 70%, amber 70–90%, red > 90%.

### `GET /door/stats/stream?eventId=` · **Server-Sent Events** — live push
```
Content-Type: text/event-stream

event: stats
data: { …DoorStatsDto… }

: keep-alive          ← every 15s, ignore it

event: closed
data: { "reason": "expired" | "unavailable" }
```
- **Frames are only sent when something actually changed.** Silence is normal.
- `event: closed` with `reason: "expired"` → the 15-minute lifetime cap.
  **Reconnect.** This is expected, not an error.
- `reason: "unavailable"` → access was revoked or the event vanished. Stop and
  send the user back.
- **429** on connect means too many open streams (10/user, 500 global).
  Fall back to polling `GET /door/stats`.
- ⚠️ **React Native's `EventSource` is not built in.** Use a fetch-based SSE
  reader so you can send the `Authorization` and `X-Organization-Id` headers —
  browser `EventSource` cannot set headers, and there is deliberately **no**
  token-in-query-string fallback.
- Always keep the poll as a fallback path.

---

## 11. Flow 7 — Guests tab

### `GET /door/guests?eventId=&status=&source=&search=&limit=` · `AUTH_READ`
```jsonc
{ "items": [ { "id", "name", "ticketType", "entryType", "quantity",
               "source": "online" | "door",
               "status": "entered" | "not_entered",
               "enteredAt", "scansUsed", "scansAllowed" } ],
  "truncated": false }
```

**Filtering and search are server-side parameters — do not download the list
and filter locally.** A festival roster is tens of thousands of names.

- `status` / `source` / `search` (name, case-insensitive) / `limit` (≤1000,
  default 200).
- Sorted **not-entered first**, then alphabetical.
- **`truncated: true` → tell the user.** "Showing first N — refine your
  search." A silently cut list is how a guest gets wrongly turned away.
- Debounce `search` (~300ms) and send it to the server.

### `POST /door/guests/check-in` · `STANDARD_COMMAND` **+idem** — manual check-in
For a cracked screen or dead phone. Requires the `ticket.override` permission.
```jsonc
{ "eventId": "…", "entitlementId": "<the guest row's id>" }
// 201 → { "guest": { …DoorGuest… }, "checkInId": "…" }
```
Runs the same atomic claim as the camera — it **cannot** be used to get past
an already-spent or voided ticket (400).

---

## 12. Supporting calls

| Method | Path | Class | Notes |
|---|---|---|---|
| POST | `/door/heartbeat` **+session** | `SCANNER_COMMAND` | `{ eventId, gate? }`. Send every ~30s while a shift is open, so the dashboard shows this device as live |
| POST | `/door/staff-deny` **+session** | `SCANNER_COMMAND` | `{ eventId, qrPayload?, reason }`. Physically refusing someone whose ticket scanned fine. **Does not spend the ticket** |
| POST | `/door/override` | `SENSITIVE_COMMAND` | `{ checkInId, reason }`. Manually admit a **denied** scan. 409 if it isn't denied. Needs `ticket.override` |
| GET | `/door/check-ins/:checkInId` | `AUTH_READ` | One ledger row |
| GET | `/door/sessions/:sessionId` | `AUTH_READ` | `sessionToken` is always `null` here |
| GET | `/tickets/:ticketId/qr` | `AUTH_READ` | Rotating ticket QR (guest or venue staff) |
| GET | `/cover-wallets/:walletId/qr` | `AUTH_READ` | Rotating tab QR — **the guest only**, staff cannot mint it |

### Manager-only (`door.manage`) — a dashboard, not the scanner app

| Method | Path | Notes |
|---|---|---|
| POST | `/events/:eventId/door-codes` | Mint a door code |
| GET | `/events/:eventId/door-codes` | List codes (returns the secret code strings) |
| POST | `/door-codes/:codeId/revoke` | Revokes the code **and every live session it opened** |
| GET | `/door-codes/:codeId/sessions` | Which devices are scanning now |
| POST | `/door/sessions/:sessionId/revoke` | Kill one shift |
| GET | `/door/devices` | Handsets and their liveness |
| POST | `/door/devices/:deviceId/unbind` | Lost/stolen phone — takes effect on the next scan |
| POST | `/door/devices/:deviceId/reauthorize` | Restore an unbound handset |

---

## 13. Non-negotiables for the front end

1. **Never store the access token or scanner-session token outside secure
   storage**, and never log either.
2. **Never send a price or an amount.** Neither money endpoint accepts one.
3. **Never mint a new idempotency key on retry.** One key per user tap.
4. **No offline queue for admissions.** Offline = deny, clearly.
5. **Drive UI from `permissions`,** not from a role name.
6. **Handle `null` capacity and `null` balance** — render the absence, never a
   fabricated default.
7. **Respect `truncated`** on the guest list.
8. **Log `requestId`** from every error; it is how backend traces your call.
9. **A hidden button is not a permission.** The server decides; the UI only
   reduces confusion.
10. **Never build refund / top-up / freeze UI** into the scanner.
