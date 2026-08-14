# Work report — 14 Aug 2026

**Author:** Sagar · **Repo:** `C1RCLE-BACKEND` · **Branch:** `main`
**Range:** `f075c0a` → `fc630c8` (8 commits) · 92 files changed, +12,393 / −212
**Suite at end of day:** 276 tests green · boundaries clean · contract parity clean

---

## 1. Headline

Four roadmap phases moved. Phase 0 carry-overs closed, **Phase 3 finished**,
**Phase 1 built and closed out**, and **Phase 2 built end to end** — applicant
KYC/onboarding plus the platform-admin authority system that decides it.

| # | Phase | Before today | After today |
|---|---|---|---|
| 0 | Foundation | done, with carry-overs | **done**, carry-overs closed |
| 1 | Partner dashboards | not started | **substantially done** |
| 2 | KYC / Onboarding | not started | **substantially done** |
| 3 | Event catalog & scheduling | partial (domain only) | **done** |
| 4–8 | Checkout, door, finance, admin console, social | not started | not started |

Test count went from **39** (after the merge reconciliation) to **276**.

---

## 2. Commit by commit

### `4aa29ca` — close every Phase 0 carry-over; start Phase 1 domain

- Restored the domain and contract suites lost in the teammate merge.
- Closed the outstanding Phase 0 items so nothing was left half-wired.
- Laid the Phase 1 domain groundwork.

### `cfb46d0` — Phase 3: event-catalog routes

Ticket tiers, promo codes, table packages and promoter assignments — routes,
contracts and HTTP tests over the domain models that already existed. **This
finished Phase 3.**

### `b05ce4b` — Phase 1: partnership repository, service and routes

The venue↔host graph. `PROMOTER_COMMISSION_TIERS` ported from v1
(0 → 10% Base … 100 → 20% Diamond); `commissionPaise` rounds **down**, so the
platform never pays out a paisa it did not collect.

### `e948913` — Phase 1: partner access matrix

v1's permission tables plus `tabVisibilityFor`, computed **server-side**. The
frontend's `grantedPermissions: ['*']` mock is replaced by a real answer; the
gateway is the authority on what a role may see, never the client.

### `0452c63` — Phase 1: partner analytics routes (read-model only)

Reads go through `AnalyticsReadModelRepository`. Deliberately no per-request
scans: the numbers are precomputed at write time, and field names match the
v1-proven dashboard contract so the frontend needs no translation layer.

### `b23ccb7` — Phase 1: promoter referral links

Code alphabet excludes `O/0/I/1/L` — these get read aloud and printed on
flyers, and lookalike characters cost real conversions. Clicks and conversions
**do not bump `version`**: a popular link would become unwritable under
contention for a counter that is not the authoritative record of the sale.
Attribution is captured onto the order at purchase time and never recalculated
from the link afterwards.

### `fdca147` — Phase 1: promoter connections; close out the phase

The promoter↔host/venue graph, kept separate from `Partnership` because the
parties and the allowed actions differ. Only the **recipient** may approve or
reject; only the **promoter** may revoke. Includes v1's "BUG-2" fix — the pair
is blocked while a connection is `pending` **or** `active`, not `pending` alone.

### `fc630c8` — Phase 2: KYC/onboarding, tiered admin authority, dual control

Detailed below.

---

## 3. Phase 2 in detail (the day's largest piece)

### Domain

**`onboarding.ts`**
- FSM: `draft → submitted → approved | rejected | changes_requested`, with
  `changes_requested → submitted` so an applicant can fix and resubmit.
  `approved` and `rejected` are terminal.
- `PLAN_PLATFORM_FEE_PERCENT` ported verbatim from v1's `approveOnboarding`:
  **basic 15 / silver 12 / diamond 10**.
- `REQUIRED_DOCUMENT_LABELS` (`id_front`, `id_back`, `selfie`) gate submission —
  fail at submit, not mid-review.
- Re-uploading a label **replaces** it. Keeping both copies invites an admin
  approving the stale one.
- `sanitizeApplicantProfile` is v1's `role`-stripping privilege-escalation guard
  rebuilt as an **allow-list**, so a field added later cannot arrive carrying
  authority with it.

**`admin-authority.ts`**
- TIER1 / TIER2 / TIER3 exactly as v1 defined them (TIER2 =
  `ONBOARDING_APPROVE`, `VENUE_SUSPEND`, `FINANCIAL_REFUND`,
  `PAYOUT_BATCH_RUN`; TIER3 = `ADMIN_PROVISION`, `COMMISSION_ADJUST`,
  `PAYOUT_FREEZE`, super only).
- `PlatformAdmin` aggregate.
- propose → resolve dual control. **A proposal cannot be resolved by the admin
  who raised it** — otherwise the second signature is theatre.

### Ports and adapters

New ports: `OnboardingRepository`, `PlatformAdminRepository`,
`ProposedActionRepository`, `VerificationAttemptRepository`,
`AdminAuditRepository`, `VerificationProvider`.

`AdminAuditRepository` is separate from the existing `AuditRepository` because
the roadmap requires **before/after** state, and a single `snapshot` field
cannot answer "what did this admin actually change?" — the only question an
audit of privileged action is ever asked.

Memory **and** Firestore adapters for every one, both under the same
compare-and-set invariant, so one contract suite is evidence about both.

### Application

- **`AdminAuthorityService`** — resolve → authorize → record. Also the proposal
  desk. `provisionAdminFromProposal` reads its payload from the *approved
  proposal*, never from the executing call, so the executing admin cannot
  approve one thing and provision another.
- **`OnboardingService`** — applicant side keyed by user id (an applicant has
  no organization yet); admin side gated on `ONBOARDING_APPROVE`. Approval
  provisions the organization with the plan's fee and **only** the capability
  applied for.

### Routes

- `/api/v2/onboarding/*` — applicant, not org-scoped, no `X-Organization-Id`.
- `/api/v2/admin/*` — review queue, decisions, proposal desk, admin roster,
  audit trail.
- 19 HTTP tests covering what would otherwise fail silently: cross-applicant
  reads collapse to 404, `support` cannot approve, self-approval is refused,
  approval provisions exactly one org with the right fee and capability.

---

## 4. Decisions recorded (`docs/architecture/decisions.md`)

### D-017 · Platform authority is not organization authority

The shortcut was to reuse `OrganizationRole` with a flag. Rejected: an org role
answers "what may you do inside your own tenant", a platform role answers "what
may you do to everyone else's". Collapsing them is how a partner ends up able to
approve their own onboarding. `PlatformAdmin` is its own aggregate; admin routes
carry no `requirePermission` **deliberately**, because checking an org
permission there would be checking the wrong question.

Revocation is **not** dual-controlled even though provisioning is — making it
hard to remove authority is the wrong failure mode when an account is
compromised. An admin still cannot revoke themselves.

### D-018 · v1's "verification" was a format check, and is labelled as one

v1's Aadhaar check was a Verhoeff checksum on the number. A checksum proves the
digits are well-formed and nothing else. Porting it as-is would leave a
verification-shaped hole in the approval path.

`ports/verification.ts` is a pluggable seam. The default is named
`FormatCheckVerificationProvider`, reports `provider: 'format-check'` /
`reason: 'format_ok'`, and approval still requires a human TIER2 decision —
**there is no auto-approve path.** The failure mode that mattered was an
operator reading a green tick as "identity confirmed".

Attempts are bounded at 5 per 24h per applicant, **including provider errors**:
an unbounded check is an oracle, and an attacker who can induce errors would
otherwise get unlimited free tries. The HTTP rate limiter bounds a *caller*;
only the attempt budget bounds an *applicant*.

### D-019 · The platform fee lives outside `OrganizationProps`

`platformFeePercent` is a top-level field on `Organization`, not a key in
`settings` — `updateOrganization` merges partner-supplied settings, so a
commercial term stored there would be self-editable. Changing it is a TIER3
`COMMISSION_ADJUST`.

Approval writes the organization **before** the request status: a failure after
the org exists leaves the request `submitted` and retryable, whereas the
opposite order would leave an approved request pointing at an organization that
was never created — which nothing can repair.

---

## 5. Things worth flagging to the team

1. **`X-User-Id` is honoured on `STORAGE_DRIVER=memory` only.** That driver
   already fabricates the whole actor from a hardcoded `dev-user`, which made
   "applicant A cannot read applicant B's application" and admin-vs-applicant
   untestable at the HTTP layer. On `firestore` the identity comes from the
   verified session and the header is ignored entirely. **It looks like an auth
   bypass in isolation** — hence this note.

2. **`Organization` gained `platformFeePercent`.** Firestore documents written
   before today have no such field; the adapter reads them as **15** (the basic
   plan's rate, which is what they were created under).

3. **The first `super` admin is seeded out of band**, via
   `pnpm --filter api-gateway seed:admin -- --user-id <id> --email <email>`.
   Provisioning through the API is TIER3 and needs two existing admins to sign,
   so the first one cannot come from the API — that is the correct shape (no
   self-service path to platform authority), and the script is the one-time
   break in the cycle. It refuses to run on the memory driver, refuses when an
   active admin already exists unless `--force`, and writes an `ADMIN_SEED`
   audit record marked as out-of-band.

4. **`mapDomainError` learned `unauthorized`.** It previously fell through to an
   unmapped 500 for that code.

---

## 6. What is remaining

### Not started

| # | Phase | Blocked by |
|---|---|---|
| 4 | **Guest checkout & tickets** — discovery/directory, pricing, Razorpay checkout, promo redemption, entitlement/QR, wallet | nothing — this is next |
| 5 | Door / scanner / cover-wallet | Phase 4 (entitlements must exist) |
| 6 | Finance / ledger / payouts — settlement engine, bank accounts, disputes, T+3 batch | Phase 4 (orders must exist to settle) |
| 7 | Admin console backend | Phase 6 for financial actions — its **authority layer already exists** from Phase 2 |
| 8 | Social / discovery / notifications | lowest priority; the roadmap says do not start until 0–7 are live |

Phase 4 is the largest single chunk left, and both 5 and 6 sit behind it.

### Open items inside phases marked done

**Phase 1**
- Finance dashboard endpoints — deliberately deferred, they need Phase 6's ledger.
- Richer per-role overview shapes; `PartnerEventSummary` / `PartnerEventDetail`
  contracts.

**Phase 2**
- Signed storage-upload URLs. `addDocument` currently takes a `storagePath` the
  client has already written to; issuing signed URLs needs a Firebase Storage
  bucket decision that has not been made.
- Approval email — no mail transport exists in V2 yet; it belongs with
  notifications (Phase 8).
- `v2_verification_attempts` is stored flat with a `userId` field rather than
  v1's `{userId}/attempts/{id}` nesting, because a flat collection is what
  `countSince` can aggregate server-side.

**Cross-cutting**
- Frontend remediation backlog — `docs/reference/frontend-api-map.md` §4. Mock
  routes to delete or repoint. Separate repo, not backend work. Six of those
  rows moved from **BLOCKED/Delete** to **LIVE/Replace** today (F5, F6, F10,
  F12, F13, F14) now that real onboarding endpoints exist.

### Known limitation, previously reported

The T-series reference implementation does not exist in the local `thec1rcle`
checkout on any branch, so its suites could not be ported and **B13 parity
against it stays blocked**. This is unchanged from the earlier session and is
recorded at the top of `task.md`.

---

## 7. Verification

Every commit today was made against a green tree. Final state:

```
pnpm check      → format ✓  lint ✓  typecheck ✓  boundaries ✓  test ✓  build ✓
tests           → 12 contracts + 165 core (+3 skipped) + 99 gateway = 276 passing
boundaries      → clean
contract parity → clean, 33 behavioural checks agree with C1RCLE-FRONTEND
```

Docs updated in the same commits: `docs/roadmap/ROADMAP.md` status table, the
Session Logs in `phase-01`/`phase-02`/`phase-03`, `docs/architecture/decisions.md`
(D-017 → D-019), and `docs/reference/frontend-api-map.md`.
