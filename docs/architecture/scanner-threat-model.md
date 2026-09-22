# Scanner backend — threat model and security review

> **Scope:** the door/scanner surface (`/api/v2/door/*`, `/api/v2/door-codes/*`,
> `/api/v2/cover-wallets/*`, `/api/v2/tickets/:id/qr`, `/api/v2/events/:id/door-codes`).
> **Reviewed:** 2026-09-15, against the code as committed to the working tree.
> **Method:** walk each asset, name who wants it and how they would try, then
> point at the control and the test that pins it.
>
> This is a living document. Add a row when you add a route; if a row has no
> test, say so rather than leaving the gap implied.

---

## 1. What is worth stealing

A door is an unusually rich target because four different things of value sit
behind one phone:

| Asset | What an attacker gets | Who realistically tries |
|---|---|---|
| **Free entry** | A night out worth ₹1,500–₹5,000, repeatable | Guests, touts reselling forged QRs |
| **A guest's bar tab** | Real money, silently | A dishonest staff member; a thief with a stolen handset |
| **Door cash** | Sales taken but not recorded | A dishonest staff member |
| **The guest list** | Names, phones, who attended what | Anyone; it is also a privacy-law liability |
| **Another club's data** | Competitor intelligence — attendance, pricing, guests | A partner on the same platform |

The last one matters more than it first appears: this is a multi-tenant
platform where competing venues hold real logins. Cross-tenant isolation is
not a theoretical control here.

---

## 2. Trust boundaries

```
Guest phone (untrusted)          Staff handset (semi-trusted)
      │ shows QR                        │ Bearer + X-Organization-Id
      │                                 │ X-Scanner-Session-Token
      ▼                                 ▼
             ┌──────────────────────────────────┐
             │  nginx edge — rate limits, header │
             │  washing, TLS termination         │
             └──────────────────────────────────┘
                              │
             ┌──────────────────────────────────┐
             │  gateway — authn, RBAC, tenancy,  │
             │  schema validation, idempotency   │
             └──────────────────────────────────┘
                              │
             ┌──────────────────────────────────┐
             │  core — the actual decisions      │
             └──────────────────────────────────┘
                              │
                    Firestore (v2_* collections)
```

**The staff handset is semi-trusted and nothing more.** It is a consumer phone
in a loud, dark room, often shared, sometimes stolen. Every value it sends is
attacker-controllable. The design assumption throughout is that a handset will
eventually be in the wrong hands, and the question is only how much that
costs.

---

## 3. Controls, by attack

### 3.1 Forging entry

| Attack | Control | Pinned by |
|---|---|---|
| Replay a screenshotted ticket QR | QR rotates on a 30s window, HMAC-signed; payloads more than ±2 windows out are refused as replays | `scanner-routes.test.ts` "admits a genuine rotating magic-QR payload" |
| Forge a QR signature | HMAC-SHA256 with `MAGIC_TICKET_SECRET`; compared with `timingSafeEqual`, so a wrong guess leaks no timing | `scanner-routes.test.ts` "denies an unverifiable magic-QR payload" |
| Present a bare ticket id instead of a signed QR | A 3-part payload that fails verification resolves to `null` and is **denied** — never falls through to the bare-id path | same |
| Scan one ticket at two doors at once | Admission is a single Firestore transaction (`claimAdmission`); the loser is denied `already_used` | `scanner-routes.test.ts` "never double-admits … concurrently" |
| Use a couple ticket for three people | Both seats consumed in **one** claim, and the confirmation token carries the expected scan count | `door-ops-routes.test.ts` "cannot be replayed to admit four people" |
| Reuse a couple confirmation at another door | Token binds ticket + event + session + device | "rejects a confirmation aimed at a different door" |
| Forge a confirmation token | HMAC with a `confirm:` purpose prefix, domain-separated from ticket QRs | "rejects a forged confirmation token" |
| Re-enter on a refunded ticket | `evaluateAdmission` refuses `void`, and does so **without** spending a seat | `admission.test.ts` "never spends a seat on a ticket it refuses" |
| Talk staff into an override, then re-enter | An override is its own terminal state and does **not** credit a scan back | `scan-ledger.test.ts`, D-025 |

### 3.2 Stealing a handset

This is the scenario the device model exists for.

| Attack | Control | Pinned by |
|---|---|---|
| Keep scanning with a stolen phone | `POST /door/devices/:id/unbind` — refused on the very next scan, even though the session token is still cryptographically valid | `door-ops-routes.test.ts` "refuses a scan from an unbound handset even while its session is live" |
| Finish the shift after unbinding | Unbinding also revokes that handset's live sessions | "unbinding also closes the sessions that handset had open" |
| **Re-register the phone to undo the revocation** | `POST /door/devices` **refuses to reactivate**; only `door.manage` can, via `/reauthorize` | "an ordinary register cannot resurrect an unbound handset" |
| Start a fresh shift on the stolen phone | `startShift` binds first, so an unbound device fails there too | "starting a shift on an unbound handset is refused" |
| Read the session token out of the database | Only its SHA-256 hash is stored; the raw token is returned exactly once | `event-code.test.ts` "returns a raw token that is NEVER carried on the stored session" |

> **Found during this review.** The re-registration row was a live hole: the
> self-register endpoint is deliberately ungated so staff can onboard a phone
> without a manager, and it happily reactivated an unbound device — which
> meant a revocation could be walked straight back by whoever held the phone.
> Fixed by splitting reactivation onto its own `door.manage` route.

### 3.3 Stealing money

| Attack | Control | Pinned by |
|---|---|---|
| Overcharge a tab (₹5,000 for a ₹500 drink) | A charge names a **preset item**; there is no amount field on the wire | `door-commerce-routes.test.ts` "rejects an amount sent by the client" |
| Charge an item the venue does not sell | `findChargeableItem` fails closed on unknown and on `isAvailable: false` | "refuses an item the venue has switched off" |
| **Charge a tab with the guest not present** | Only the **guest** can mint their tab QR — staff cannot | "is refused for VENUE STAFF" |
| Double-bill by retrying | Idempotency key, dual-checked, plus a 3-charges/minute/device velocity limit | "never double-bills on a retry" |
| Drain a frozen or empty tab | Balance checked before the debit; frozen wallets refuse all mutations | "refuses a charge the tab cannot cover, without partially charging" |
| Discount a door sale for a friend | Price recalculated from the tier; no amount field exists | "ignores any price the client tries to send" |
| Take cash twice for one sale | Order id derived from the idempotency key; a retry replays | "charges once when a dropped response is retried" |
| Sell entry from an entrance-only handset | Requires a `full` (door-entry) session | "refuses a scan_only session" |
| Ring up drinks from an entrance handset | Requires a `charge` session | "refuses a scan_only session — an entrance handset is not a bar" |
| Reverse a charge to pocket the difference | Refunds/top-ups/freezes are **not in the scanner** at all | by absence |

> **Found during this review.** The guest-only QR rule was the second live
> hole. Staff could originally mint any wallet's QR "to help a guest with a
> dead phone" — which also meant a staff member could produce the QR and charge
> a tab with nobody standing there. The helpful case is a supervisor-console
> problem, exactly like refunds.

### 3.4 Reaching another club's data

Every one of these answers **404, never 403**, so the response cannot be used
to confirm that something exists.

| Attack | Control | Pinned by |
|---|---|---|
| Mint a door code into another org | Code's org is taken from the **event**, never from the request | `scanner-routes.test.ts` "carrying the event's organization, not one the caller names" |
| Guess another club's door code | Foreign code answers identically to a non-existent one | "answers a foreign organization's real code identically to an unknown one" |
| Replay a session token under another tenant | Session org re-checked on every scan | `scanner-routes.test.ts` |
| Learn whether a rival's ticket is valid | `wrong_event` is answered **before** ticket state, and returns no name, tier or counts | `admission.test.ts` "answers wrong_event BEFORE looking at the other club's ticket state" |
| Read a rival's roster | `requireOrgAccess` on the event | `door-ops-routes.test.ts` "refuses another organization's roster" |
| Read a rival's live occupancy | Same, checked before the stream opens | `door-stats-stream.test.ts` "refuses another organization's event BEFORE opening a stream" |

### 3.5 Denial of service

| Attack | Control |
|---|---|
| Flood the scan endpoint | `SCANNER_COMMAND` 300/min — sized for a real door queue, still bounded |
| Brute-force door codes | `SENSITIVE_COMMAND` 10/min on session open; codes are ~2^37 from a CSPRNG |
| Exhaust rate-limiter memory with rotating IPs | `MAX_TRACKED_KEYS` LRU eviction (pre-existing) |
| **Open streams and never close them** | Per-actor (10) and global (500) connection budget; slots released on close, error and timeout | `door-stats-stream.test.ts` connection-budget suite |
| Hold a stream open forever | 15-minute hard lifetime, then the client reconnects and is re-authorized |
| Stall a stream to make the server buffer | A failed `write` closes the connection instead of buffering |
| Read a festival's roster into gateway memory | Scan bounded (20k entitlements / 2k door sales); filtering is server-side; overflow reported as `truncated` |
| Make the stats query expensive | Firestore `count()`/`sum()` aggregates, one per tier — cost does not grow with attendance |

> **Found during this review.** The roster read paged *every* entitlement for
> an event into memory and returned the lot. For a festival that is both an
> out-of-memory risk and tens of thousands of guest names crossing the wire to
> a phone. Now bounded, filtered server-side, and honest about truncation.
>
> Also found: the admissions breakdown sampled 5,000 ledger rows. Above that it
> silently understated categories while the total stayed correct — the worst
> kind of wrong, because nothing looks broken. Now exact at any scale.

### 3.6 Privacy

| Concern | Control |
|---|---|
| Guest names in logs | Roster and stream responses are `no-store`; pino redacts credentials; scan ledger is not logged |
| Scanner session token in logs | `x-scanner-session-token` is in the pino redact list |
| Door code in an audit record | Deliberately omitted — audit records are read by more people than may open a door |
| A bartender seeing a guest's full identity | The charge view is **first name only**, and balance display is a venue setting |
| Another tenant's guest name on a denial | `wrong_event` attaches no entitlement data |
| Offline-sync request bodies persisted for replay | Per-scan payloads are bounded QR captures (≤512 chars, HMAC-signed, no names) stored only in the idempotency ledger, which is never logged |

### 3.7 Firestore composite indexes (deployment checklist)

These scan-ledger queries need explicit composite indexes (single-field
indexes do not cover multi-`where`/`orderBy` reads; the emulator surfaces the
missing-index error at request time, not deploy time). Add them to the
Firestore index config (`firestore.indexes.json` / `firebase.json` per
`docs/reference/task.md` §T18) and verify with the emulator before relying on
the count/door dashboards:

| Query | Index |
|---|---|
| `findOfflineScans` (`eventId ==`, `isOffline ==`, `scannedAt <`) | `eventId ↑, isOffline ↑, scannedAt ↑` |
| `findByEventAndEntitlement` (`eventId ==`, `entitlementId ==`) | `eventId ↑, entitlementId ↑` |
| `findByEvent` (`eventId ==`, `orderBy scannedAt desc`) | `eventId ↑, scannedAt ↓` |
| `findByOrganization` (`organizationId ==`, `orderBy scannedAt desc`) | `organizationId ↑, scannedAt ↓` |
| `findByDevice` (`deviceId ==`, `orderBy scannedAt desc`) | `deviceId ↑, scannedAt ↓` |
| `findByOperator` (`operatorUid ==`, `orderBy scannedAt desc`) | `operatorUid ↑, scannedAt ↓` |
| `countByEventAndStatus` (`eventId ==`, `status ==`) | `eventId ↑, status ↑` (`count()` requires an index) |
| `countConsumedByEntitlement` (`entitlementId ==`, `status ==`) | `entitlementId ↑, status ↑` |

---

## 4. Secrets

| Secret | Guards | If it leaks |
|---|---|---|
| `MAGIC_TICKET_SECRET` | Ticket QRs, cover-wallet QRs (different purpose prefixes), offline manifests, couple-confirmation tokens | Anyone can mint entry and charge tabs. **Rotate immediately**; all outstanding QRs invalidate, which is the correct behaviour. |
| `BETTER_AUTH_SECRET` | All sessions | Full impersonation |
| Door codes | One event's scanner authorization | Revoke the code — live sessions die with it |
| Scanner session tokens | One device, one shift, 12h | Unbind the device |

Production refuses to boot without a real `MAGIC_TICKET_SECRET` (32+ chars).
That guard exists because it previously fell back to a constant published in
the source — see D-025.

**One key, four purposes, separated by prefix** (`wallet:`, `confirm:`,
`manifest:`, and the bare ticket form). Domain separation means a token minted
for one purpose can never verify as another. Splitting into four keys would be
marginally stronger and materially harder to rotate; if that trade ever
changes, the prefixes are already the seam.

---

## 5. Accepted risks

Stated so they are decisions rather than oversights.

| Risk | Why accepted | Revisit when |
|---|---|---|
| A valid scanner session can tell "ticket exists somewhere" from "no such ticket" (`wrong_event` vs `invalid_signature`) | Requires a live door session; ticket ids are SHA-256-derived and unguessable, so this enumerates nothing | If ticket ids ever become sequential |
| Door-code lookup is not constant-time | The code is ~2^37 from a CSPRNG and the endpoint is rate-limited to 10/min | If the code alphabet shrinks |
| Any org member can read the guest roster | They are venue staff; the door needs it. Not gated on a permission | If a venue asks for a role that can scan but not see names |
| Rate limits and stream budgets are per-instance | The deployment is a single instance today | Before adding a second instance — needs Redis |
| Offline manifests exist but the app denies offline | A venue may opt in; sync re-runs the full server-side decision, so a device cannot admit anyone by itself | If the app starts using it |
| The stream is poll-backed (≤3s latency) | An occupancy gauge does not need sub-second; it is correct on any number of instances without fan-out | If latency becomes a real complaint |

---

## 6. Design principles this surface follows

1. **Fail closed.** Unknown device, unknown item, unverifiable QR, missing
   config — all refuse. There is no default-allow path.
2. **The client never names a price.** Not for a tab, not for a door sale.
3. **The client never names an identity.** Operator comes from the session,
   device from the session token, organization from the event.
4. **Decide and write in one transaction**, in the adapter where atomicity
   actually exists — not read-then-write in a service.
5. **Two credentials for anything at a door**: who you are, and what device
   you are on. Either alone is insufficient.
6. **Refusals answer identically to absences**, so no endpoint is an oracle.
7. **Every refusal is recorded.** A door with no record of who it turned away
   cannot answer the question it will be asked.
8. **Bound every read.** No endpoint pages an unbounded collection into
   memory; overflow is reported, not silently cut.
9. **One writer per fact.** Door revenue settles through the same
   `settleOrder` as online revenue rather than a second path that can drift.
10. **Say what is not done.** An honest 501 or a documented gap beats a stub
    that looks finished.
