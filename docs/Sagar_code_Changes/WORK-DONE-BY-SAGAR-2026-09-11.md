# Work done by Sagar — 2026-09-11

> **Purpose of this file:** a running record of what was built, what it fixed,
> what is verified, and what is still outstanding — written to be readable by
> someone who is not in the code every day.
>
> **Branch:** `staging` · **Repo:** `C1RCLE-BACKEND`
> **Scope of today's work:** the Scanner / Door backend (Phase 5).

---

## 1. Headline

The scanner backend existed but **was not safe to put in front of a real club
night**. It had six independent problems, any one of which would have caused a
bad night at a door: there was no way to authorize a scanner device at all, the
device identity was a value any caller could type, a scanned ticket was never
actually marked as used, two scanners could admit the same guest twice, the
ticket QR signing key was a constant published in the source code, and the
credentials were generated with a non-cryptographic random number generator.

All six are fixed and covered by tests. The door now supports multiple clubs,
multiple venues and multiple devices per event at the same time, with strict
isolation between them.

**Status: complete and verified.** `pnpm check` is fully green — formatting,
lint, typecheck, architecture boundaries, **825 tests**, and build.

---

## 2. What was wrong, and what it does now

| # | Problem found | Why it mattered | Fixed how |
|---|---|---|---|
| 1 | **No route existed to create a door code.** The service method was there but registered on no endpoint. | A scanner could only be authorized by writing a database record by hand. In production, the door could not be opened at all. | New manager-facing routes to mint, list and revoke door codes, plus a new `door.manage` permission. |
| 2 | **Device identity came from the request body.** The scan trusted a `deviceId` string the caller typed. | The whole permission model (`full` / `scan_only` / `charge`) decided nothing — anyone with a staff login could scan as any device. | Every scan now requires `X-Scanner-Session-Token`, issued once when a device redeems a door code and stored only as a hash. |
| 3 | **A scanned ticket was never marked used.** The scan wrote a log row and returned. | A couple ticket (admits 2) was refused on the second person. A ticket's own record never showed it had been used, so the guest wallet and reports were wrong. | Admission now goes through a single atomic "claim" that increments the ticket's scan count. |
| 4 | **Two scanners could both admit the same guest.** The duplicate check and the write were two separate database calls. | Two doors scanning the same QR at the same moment both let the guest in. Direct revenue loss and a capacity problem. | The check and the increment happen inside **one database transaction**. Pinned by a concurrency test. |
| 5 | **Ticket QR codes were signed with a published constant.** The signing key was never passed from configuration, so every deployment used `default-magic-ticket-secret-change-in-production`. | Anyone who could read the source could generate a valid QR for any ticket. Signature comparison was also non-constant-time. | `MAGIC_TICKET_SECRET` is wired through and **production refuses to start without it**. Signatures compare in constant time; stale QR windows are rejected as replays. |
| 6 | **Credentials came from `Math.random()`,** and the raw session token was stored in the database next to its own hash. | Door codes and session tokens were predictable, and a database read (or a leaked backup) was enough to impersonate a scanner. | Cryptographic random for both. The raw token never touches stored data. Door codes use an alphabet with no `O/0`, `I/1`, `S/5`, `B/8` — staff read these off one screen in a dark room and type them into another. |

### Smaller bugs fixed along the way

- **A 409 error on an ordinary second scan.** The scan log's ID was derived
  from the millisecond timestamp alone, so two scans of the same ticket inside
  one millisecond collided. Door staff would have seen a hard error on a normal
  second scan of a couple ticket.
- **Reading back an overridden scan returned a 500.** The response shape did
  not include the `overridden` status that the override feature itself creates.
- **A "check this ticket" preview reported `consumed`.** Nothing had been
  consumed — a preview reading as "this guest has been admitted" is the kind of
  wording that gets someone let in twice. Previews now answer `valid` /
  `invalid` on their own response shape.
- **Cross-tenant reads returned 403 instead of 404** in two places, which
  confirms that another club's event or door code exists.

---

## 3. What is new

**New endpoints (door-code management — `door.manage` permission):**

| Method | Path | What it does |
|---|---|---|
| POST | `/api/v2/events/:eventId/door-codes` | Mint a door code for an event |
| GET | `/api/v2/events/:eventId/door-codes` | List that event's active codes |
| POST | `/api/v2/door-codes/:codeId/revoke` | Revoke a code **and every live session it opened** |
| GET | `/api/v2/door-codes/:codeId/sessions` | Which devices are scanning right now |
| POST | `/api/v2/door/sessions/:sessionId/revoke` | Kill one device's session (lost/stolen phone) |

**`GET /api/v2/door/offline-manifest` is now real.** It was previously an
honest "not implemented" because signing a manifest that nothing verifies is
security theatre. The sync path now re-runs the full server-side admission
decision for every offline scan and returns real conflicts, so two offline
devices that both admitted the same ticket produce **one** admission and one
recorded conflict.

**New rate-limit class `SCANNER_COMMAND` (300/min).** A busy club door scans
faster than the standard 60/min budget; throttling it would hold up a real
queue.

---

## 4. How multi-club / multi-venue isolation works now

This was the explicit requirement, so here is the chain in full:

1. A door code is created **from the event**, so its organization is the
   event's owner — a caller cannot mint a code into another club's tenant by
   naming their organization id.
2. Redeeming a code checks the caller's organization. **Another club's real
   code answers exactly like a code that does not exist (404),** so this
   endpoint cannot be used to guess door codes across the platform.
3. A session belongs to the code, the code to the organization. The scan
   re-checks the session's organization, so a token minted under one tenant
   cannot be replayed under another.
4. A ticket issued for another club is refused as `wrong_event` **with no
   details attached** — no guest name, no tier, no scan counts. A scanner at
   venue B cannot use denial reasons to learn whether a venue-A ticket is
   valid, refunded or already used.
5. Gate-restricted codes pin the gate; a device cannot scan at a gate it was
   not issued for.

---

## 5. Verification

Everything below was run, not assumed:

```
pnpm check          →  format · lint · typecheck · boundaries · test · build   ALL GREEN
  @c1rcle/core       470 passed (3 skipped)
  api-gateway        342 passed
  @c1rcle/contracts   13 passed
pnpm test:scenarios →  2 passed (full business flow, end to end)
```

The new tests deliberately pin the **security** properties, not just the happy
path:

- a scan with no token, and a scan with a fabricated token, are both refused
- a token minted for one event cannot scan another
- revoking a door code immediately stops a device that already holds a token
- a ticket cannot be admitted twice
- a couple ticket admits exactly two people and then refuses
- two devices scanning the same ticket **concurrently** produce one admission
  and one denial
- a voided ticket and a wrong-event ticket are denied **without** spending an
  admission and without leaking the other tenant's data
- a forged QR signature is denied rather than falling through to the plain
  ticket-id path
- a preview never spends an admission
- the raw session token is returned exactly once and is `null` on every read

The end-to-end scenario test now buys a ticket, pays, mints a door code over
HTTP, redeems it, scans the guest in, and asserts that a **second** scan of the
same ticket is refused.

---

## 6. Files changed

**Domain (`packages/core/src/domain/`)**
- `models/entitlement.ts` — new `evaluateAdmission`: the single rule for "may
  this ticket admit one more person right now"
- `models/event-code.ts` — CSPRNG codes and tokens, unambiguous alphabet, real
  organization on the session, raw token never stored, `hashSessionToken`
- `models/scan-ledger.ts` — scan-log IDs are now collision-free
- `ports/repositories.ts` — new `claimAdmission` + `AdmissionClaim`

**Storage adapters**
- `firestore/firestore-entitlement-repository.ts` — `claimAdmission` inside
  `runTransaction`
- `memory/memory-repositories.ts` — same rule, same atomicity guarantee
- `firestore/firestore-event-code-repository.ts`, `memory/memory-event-code-repository.ts`
  — shared token hashing

**Application**
- `application/scanner/scanner-service.ts` — rewritten (session authentication,
  atomic admission, offline manifest + verified sync, cross-tenant safety)

**Gateway**
- `routes/v2/door/event-code-routes.ts` — **new**, door-code management
- `routes/v2/door/scanner-routes.ts` — rewritten against the new contract
- `routes/v2/route-manifest.ts` — registers the new routes
- `plugins/rbac.ts` — new `door.manage` permission
- `plugins/rate-limit.ts` — new `SCANNER_COMMAND` class
- `lib/logger-config.ts` — redact `X-Scanner-Session-Token`
- `lib/v2-services.ts`, `config/index.ts` — `MAGIC_TICKET_SECRET` wired and
  required in production

**Contracts** — `contracts/phase5.ts` plus the two re-export files

**Docs** — `decisions.md` (D-025), `phase-05-*.md` session log, `render.yaml`
and the three staging/deployment docs (new required secret), this file

---

## 7. Outstanding / not done

Kept visible rather than quietly dropped:

| Item | Status | Note |
|---|---|---|
| `GET /door/stats/ws` (live push) | **Open, honest 501** | Needs `@fastify/websocket` registered on the app. Polling `GET /door/stats` works today. |
| An override does not credit a scan back to the ticket | **Deliberate** | An override is a human decision recorded against one refusal. Crediting a scan back would let one override grant unlimited entries. |
| Anonymous device-only auth (no staff login) | **Deliberate** | The scanner still needs a logged-in staff session *in addition to* the device token. That is stronger than the roadmap's original plan, and costs nothing while the scanner is a staff-operated device. |
| `MAGIC_TICKET_SECRET` must be set on Render | **Action required before next deploy** | Production now refuses to boot without it. Documented in `render.yaml` and the staging contract. |
| Frontend scanner app | **Not started** | No scanner-app repo exists yet. The backend contract is ready for it. |

### ⚠️ Deployment note

Because production now fails closed without `MAGIC_TICKET_SECRET`, **set a
32+ character random value on the Render service before deploying this**, or
the service will refuse to start. This is intentional — it replaced a silent
fallback to a key published in the source code.

---

## 8. Wider repo status (for context)

| Phase | Status |
|---|---|
| 0 — Foundation | done |
| 1 — Partner dashboards | substantially done (finance unblocked by Phase 6) |
| 2 — KYC / Onboarding | substantially done |
| 3 — Event catalog & scheduling | done |
| 4 — Guest checkout & tickets | done |
| 5 — Door / Scanner / Cover wallet | **done + hardened today**; 1 honest 501 left |
| 6 — Finance / Ledger / Payouts | done (known gap: venue revenue-share rate settles to 0 — no such field exists in the data model yet) |
| 7 — Admin console | partially started (amount-tiered refunds landed 2026-09-11 in PR #32) |
| 8 — Social / notifications | not started |

Live deployment is still the interim nginx + Fastify sidecar on Render's free
tier; the two-service topology is built and validated but needs a paid plan.
