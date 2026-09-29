# Work done by Sagar — 2026-09-15

> Running record of what was built, what it fixed, what is verified, and what
> is still outstanding. Written to be readable by someone who is not in the
> code every day.
>
> **Branch:** `staging` (nothing committed or pushed yet) · **Repo:** `C1RCLE-BACKEND`
> **Scope today:** the backend for the **Scanner App** (door staff phone app).
>
> Previous entry: [WORK-DONE-BY-SAGAR-2026-09-11.md](./WORK-DONE-BY-SAGAR-2026-09-11.md)
> (scanner security hardening — six findings closed).

---

## 1. Headline

On 11 Sep the scanner *admission* path was made safe. Today's work builds the
rest of the app's backend: everything the door staff's phone does that is not
the camera, plus the two-step couple-ticket flow the camera needs.

A door device can now: log in, see tonight's events at its venue, start a
shift on one, register itself as an authorized handset, scan guests in,
handle couple tickets with a "both guests present?" confirmation, record a
refusal, work the guest roster, check someone in by hand, and report live
occupancy against the room's capacity.

A guest can also now pay at the door for a real ticket, and have their bar
tab charged from the scanner.

Live occupancy now pushes to any screen left open, and I ran an adversarial
security review over the whole surface — which found and closed two real
holes (§5).

**Status: the scanner app's backend is complete and verified.** `pnpm check`
fully green — **906 tests**, boundaries clean. Nothing from your feature list
is outstanding.

---

## 2. What was built

### New: door-code management was reachable by no route at all
The service to mint a scanner credential existed but was registered nowhere,
so in production a scanner could only be authorized by writing a database
record by hand. That was closed on 11 Sep; today's work builds on it.

### New: device registration and revocation

| What | Why it matters |
|---|---|
| A handset is now its own record (`v2_scanner_devices`), separate from the shift session | A session lasts one night; a venue owns a phone for years. Losing a phone must be revocable without chasing sessions. |
| Unbinding takes effect on the **next scan** | Even though that phone's session token is still cryptographically valid. That is the entire reason the two are separate records. |
| Unbinding also closes the sessions that handset had open | A revoked phone that can finish the shift is not revoked. |
| Re-registering refreshes rather than resets | The app re-registers on every launch; wiping the scan history each time would erase exactly what a manager looks at when a phone misbehaves. |
| Heartbeats keep a device visible on the dashboard | Authenticated by the session token, not by a device id in the body — otherwise anyone could keep a decommissioned phone looking alive. |

### New: event selection and one-call shift start
`GET /door/events` lists tonight's events **at this organization only**, with
"today" resolved in Indian time — an 11pm show on the 4th is a UTC-5th event,
and a device asking at 1am is still working the previous night. Drafts and
cancelled events are hidden: a shift opened on either could only ever deny
everyone.

`POST /door/sessions` now returns the whole shift in one call — session token,
what the session may do, the event, its sellable tiers, the gate, and an
opening stats snapshot — because a door phone on club wifi may not get a
second round trip.

### New: couple tickets are a two-step admission
A couple ticket admits two people and both must walk through together.
Scanning an untouched one now **stops and asks** instead of consuming a seat:

- Nothing is written while the door waits for a human. The response carries no
  check-in id, because a question is not an admission.
- The confirmation token is signed, lasts **30 seconds**, and is bound to the
  ticket, the event, the session, the device **and the exact scan count staff
  were shown**. It cannot be replayed, aimed at another door, or used after
  something else consumed a seat.
- On "yes", **both seats are taken in one transaction**. Claiming twice would
  let the two halves land either side of a concurrent scan and admit three
  people on a two-person ticket.
- On "no" (only one guest turned up), it is recorded as a real denial and
  **nothing is spent** — the pair can come back together.

### New: staff deny, guest roster, manual check-in

- **Staff deny** — someone refused at the door for being drunk or barred. The
  refusal is recorded; the ticket is **not** consumed. The guest did not get
  in, and burning their entry would turn a door judgement into a refund
  dispute.
- **Guest roster** — online tickets merged with tonight's door sales,
  not-entered first then alphabetical. "Entered" is read from the ticket
  itself, not the scan log: the log records *attempts* (including denials),
  so reading it would show a guest as entered because somebody tried.
- **Manual check-in** — for a cracked screen or a dead phone. It runs the
  **same atomic claim** as the camera, so it cannot be used to walk past a
  spent or voided ticket, and cannot race a scanner at another door.

### New: real occupancy on the Stats tab
Occupancy now sums people admitted, not scan rows — one confirmed couple row
admits two, an override admits one against a denial, a denial admits nobody.
This is a life-safety number, so it is computed properly (a server-side
`sum()` aggregate, not by reading every row).

`capacity` was added to the event and is **nullable**: when an event has none
configured the door shows a count with no limit. The old scanner UI hardcoded
500, which told staff a confident number nobody had set.

### Fixed: door guest fields were not validated at all
Ten-digit phone, 18+, a real gender value and a valid email are now enforced
**server-side**. These rules previously lived only in the app's submit button,
which means they did not apply to anyone calling the API directly. There is
still no price field on a door sale, and there never will be — the amount is
recalculated from the event's catalog.

---

### New: Cover Wallet charging on the Scan tab

The scanner can now read a guest's prepaid tab and ring up drinks against it.

| What | Why it is built this way |
|---|---|
| A charge names an **item**, never an amount | The venue keeps its own price list on the wallet; the scanner sends `presetItemId` + quantity and the server multiplies. There is no amount field on the wire. Free-entry pricing on a phone at a bar at 1am is how a ₹500 drink becomes a ₹5,000 charge — and the guest cannot check the screen before it is taken. |
| Tabs are read from a **rotating signed QR** | 30-second window, same signing key as ticket QRs under a separate purpose prefix so the two can never be swapped. A screenshot of someone's tab is worthless within half a minute. |
| A forged QR is **refused**, not treated as a wallet id | That fall-through is exactly how a signature check gets bypassed. |
| Charging **re-sends the QR** rather than a stored id | So a charge always follows a tab physically presented at the bar. |
| The bartender sees a first name, a balance and the item list — nothing else | Not the guest's id, metadata or history. The venue can also switch balance display off. |
| Only a **`charge`-type** door code can do any of this | A `scan_only` handset at the entrance cannot see, let alone bill, someone's bar tab. That is the whole reason door codes have types. |
| Retries never double-bill | Idempotent per key, on top of the existing 3-charges-per-minute-per-device velocity limit. |

Refunds, top-ups and freezes stay **out** of the scanner — they are supervisor
actions. A device that can reverse a charge at the bar is a device that can be
talked into reversing one.

### New: paid walk-up ticket sale

Someone turns up with no ticket, picks a tier, pays cash/UPI/card, walks in.

- **The price comes from the tier**, recalculated server-side. There is no
  amount field on the wire — a door sale whose total the client names is a
  door sale the client can discount.
- It creates **a real order**: paid order → issued tickets → a scan record per
  person → settlement. Revenue lands in the **same finance ledger** as online
  sales, through the same writer, so a venue's numbers are one set rather than
  two.
- **Inventory is checked first.** The door is the last place that should
  oversell a room.
- **Tickets are admitted immediately** through the same atomic claim a camera
  scan uses — the guest is standing there.
- **A retry replays instead of charging twice.** The order id is derived from
  the idempotency key.
- A cash sale carries **no gateway fee and no GST-on-fees**. Charging an
  online payment fee on cash handed to a human would be inventing a charge
  nobody is paying.
- Requires a **`full`** session: selling entry is a stronger right than
  scanning it.

### New: live occupancy push (and why it is not a WebSocket)

`GET /door/stats/stream` pushes updated numbers to a screen left open on the
door or the dashboard.

The roadmap said "WebSocket". I built **Server-Sent Events** instead, and the
reason is mostly security:

- **The data only flows one way.** The door watches numbers; it never sends
  anything up this channel. WebSocket's two-way nature buys nothing here and
  costs a second transport to secure.
- **SSE is ordinary HTTP, so it inherits every control we already have** —
  login, organization scoping, the CORS allowlist, rate limiting, the standard
  error format. A browser *cannot* attach a login header to a WebSocket, which
  is exactly why WebSocket systems end up putting the access token in the URL
  — where it lands in server logs, proxy logs and browser history. Choosing
  SSE removes that whole class of leak rather than patching it.
- **It is correct with more than one server.** Each update is recomputed from
  the database, so any server can serve any screen. A WebSocket fed by
  in-memory events would *look* like it worked and silently only deliver
  updates from whichever server that phone happened to reach — broken in a way
  nobody would notice until it mattered.

Streaming has its own risks, which normal endpoints do not, so:

| Risk | Control |
|---|---|
| Someone opens thousands of streams and never closes them | A connection budget: 10 per user, 500 overall. This is the attack a rate limiter **cannot** see — each open is one request, so the limiter never fires while sockets pile up. |
| A stream outliving the permission that opened it | Re-checked on every update, plus a hard 15-minute cap that forces a full re-login |
| An unauthorized caller getting an open stream that then errors | Authorization happens **before the first byte** — they get a normal 404 |
| A slow client making the server buffer forever | A stalled write closes the connection instead of buffering |

## 3. New endpoints

| Method | Path | Who |
|---|---|---|
| GET | `/api/v2/door/events?date=today` | Any door staff |
| POST | `/api/v2/door/sessions` | Door staff — start a shift (now returns tiers + gate + stats) |
| POST | `/api/v2/door/devices` | Door staff — register this handset |
| GET | `/api/v2/door/devices` | `door.manage` — which handsets are live |
| POST | `/api/v2/door/devices/:deviceId/unbind` | `door.manage` — lost/stolen phone |
| POST | `/api/v2/door/heartbeat` | Device (session token) |
| POST | `/api/v2/door/check-ins/confirm` | Device — couple ticket yes/no |
| POST | `/api/v2/door/staff-deny` | Device — record a refusal |
| GET | `/api/v2/door/guests?eventId=` | Door staff — merged roster |
| POST | `/api/v2/door/guests/check-in` | `ticket.override` — manual check-in |
| POST | `/api/v2/door/wallet-qr` | Device (`charge` session) — read a tab |
| POST | `/api/v2/door/wallet-charge` | Device (`charge` session) — ring up an item |
| POST | `/api/v2/door/ticket-sale` | Device (`full` session) — paid walk-up sale |
| GET | `/api/v2/cover-wallets/:walletId/qr` | **The guest only** — rotating tab QR |
| POST | `/api/v2/door/devices/:deviceId/reauthorize` | `door.manage` — restore an unbound handset |
| GET | `/api/v2/door/stats/stream` | Door staff — live occupancy (SSE) |

---

## 4. Multi-club isolation (the explicit requirement)

Unchanged from 11 Sep and extended to every new route:

1. A door code takes its organization **from the event**, so nobody can mint
   one into another club's tenant.
2. Another club's real code answers exactly like a code that does not exist —
   no oracle for guessing codes across the platform.
3. A device id only means something inside one tenant. The same handset
   carried to another club is a different, unbound device there.
4. A session token cannot be replayed under another tenant.
5. A ticket from another club is refused with **no details attached** — no
   guest name, tier or counts.
6. `GET /door/events` and `GET /door/guests` show only this organization's.

---

## 5. Verification

```
pnpm check          →  format · lint · typecheck · boundaries · test · build   ALL GREEN
  @c1rcle/core       488 passed (3 skipped)
  api-gateway        405 passed
  @c1rcle/contracts   13 passed
pnpm test:scenarios →  2 passed (full business flow, end to end)
```

New tests pin behaviour that matters at a real door, not status codes:

- an unbound handset cannot scan, **even while its session is still valid**
- unbinding mid-shift stops the device immediately
- a couple confirmation cannot be **replayed** to admit four people
- a couple confirmation **aimed at another door** is refused
- a forged confirmation token is refused
- a staff deny does **not** spend the guest's ticket
- a manual check-in cannot walk past a spent or a voided ticket
- the roster shows not-entered first, and another club's roster is a 404
- occupancy reports `null` capacity rather than inventing one
- a 5-digit phone, a 17-year-old, a free-text gender and a client-sent price
  are all rejected

On the money paths specifically:

- a client-sent amount is rejected on **both** a wallet charge and a door sale
- an item the venue switched off, and one that does not exist, are refused
- a tab that cannot cover the charge is refused **without partial effect**
- a retried charge and a retried sale each happen **once**
- a `scan_only` session can neither read a tab nor sell entry
- the door will not oversell a tier
- a door sale's revenue appears in the finance ledger

---

## 5b. ⚠️ Security review — two real holes found and closed

I went back over everything I had built and attacked it deliberately. Two
findings were genuine, and both were mine:

**1. Unbinding a stolen phone could be undone by anyone.**
`POST /door/devices` is intentionally open so staff can register a handset on
launch without waiting for a manager — safe on its own, because registering a
device grants nothing (you still need a door code and a session to scan). But
it also *reactivated* a device a manager had unbound. So: manager revokes a
stolen phone, whoever is holding it is still logged in as staff, re-registers
the same phone, and is back in.

Fixed — restoring a revoked device is now its own manager-only endpoint, and
audited. The lesson is that an endpoint's permission has to be judged against
its **strongest** effect, not its usual one: "register a device" and "restore
a revoked device" read like the same action and are not remotely the same act.

**2. Staff could charge a guest's tab with the guest not present.**
Venue staff could mint a guest's tab QR — added for the "guest's phone died"
case. But the guest showing that QR *is* the authorization for the charge, so
anyone who can create one can bill a tab with nobody standing at the bar.

Fixed — only the guest can mint their own tab QR. A dead phone is a supervisor
problem, exactly like refunds. The lesson: when a token is what authorizes
taking money, "who may read it" and "who may create it" are different
questions, and a convenience for staff was quietly an insider-fraud path.

**Two more, less severe, fixed in the same pass:**

- The guest roster paged **every** ticket for an event into memory and
  returned the lot. For a festival that is both a crash risk on the server and
  tens of thousands of guest names crossing the wire to a phone. It is now
  bounded, filtered and searched server-side, and tells the client honestly
  when a result was cut short.
- The entry-type breakdown on the Stats tab sampled 5,000 records. Above that
  it quietly understated the categories while the total stayed correct — the
  worst kind of wrong, because nothing looks broken. It is now exact at any
  size.

The full write-up, including the attacks that are *already* covered and the
risks I am deliberately accepting, is in
[`docs/architecture/scanner-threat-model.md`](../architecture/scanner-threat-model.md).

## 6. ⚠️ Not built yet (from your feature list)

Stated plainly rather than left to be discovered:

| # | Item | Status |
|---|---|---|
| 1 | **Cover Wallet charging on the Scan tab** | ✅ **Built** — see §2. |
| 2 | **Paid walk-up ticket sale** | ✅ **Built** — see §2. |
| 3 | Live push of door stats | ✅ **Built** — as Server-Sent Events rather than WebSocket, for the reasons in §2. `GET /door/stats/ws` is now absent (404) rather than a stub. |
| 4 | Realtime feed for the partner dashboard's live door view | ✅ **Built** — the dashboard consumes the same `GET /door/stats/stream`. |

Nothing from the feature list is outstanding.

Also unchanged and deliberate:

- **No offline queue for admissions.** Losing connectivity denies entry, which
  is what your spec asks for. (A pre-authorized offline manifest exists for
  venues that opt in; its sync still re-runs the full server-side decision.
  The app does not use it.)
- **An override does not credit a scan back to the ticket.**
- **The scanner needs a staff login in addition to the device token.** That is
  stronger than the original plan, and costs nothing while the scanner is a
  staff-operated device.

### Deployment note (carried over, still required)

`MAGIC_TICKET_SECRET` (32+ random characters) must be set on the Render
service before the next deploy — production now **refuses to start** without
it, deliberately, because it replaced a silent fallback to a key published in
the source.

---

## 7. Files changed today

**Domain** — `models/scanner-device.ts` (new), `models/entitlement.ts`
(`admitSeats` — the multi-seat atomic rule), `models/event.ts` (capacity),
`models/event-code.ts`, `ports/repositories.ts` (device repo, admission
aggregate), `errors.ts` (`DeviceNotAuthorizedError`)

**Storage** — memory + Firestore device adapters (new), entitlement adapters
(multi-seat claim), scan-ledger adapters (admission aggregate), event adapter
(capacity)

**Application** — `scanner/scanner-service.ts` (devices, couple confirmation,
staff deny), `door/door-ops-service.ts` (new — events, shift start, roster,
manual check-in, wallet read/charge), `door/door-ticket-sale-service.ts`
(new — paid walk-up), `door/door-stats-service.ts` (occupancy),
`cover-wallet/cover-wallet-service.ts` (tab QR, charge view, preset charging),
`checkout/checkout-service.ts` (`settleOrder` made public — one revenue writer)

**Gateway** — `routes/v2/door/door-ops-routes.ts` (new),
`routes/v2/door/scanner-routes.ts`, `routes/v2/door/cover-wallet-routes.ts`,
`route-manifest.ts`, `lib/v2-services.ts`, `routes/v2/partner/events.ts`
(error mapping)

**Contracts** — `contracts/phase5.ts` plus the two re-export files

**Tests** — `domain/admission.test.ts` (new), `domain/scanner-device.test.ts`
(new), `door/door-ops-routes.test.ts` (new),
`door/door-commerce-routes.test.ts` (new), scanner + door-sale suites

**Docs** — `decisions.md` (D-026, D-027), `phase-05-*.md` session log, this file
