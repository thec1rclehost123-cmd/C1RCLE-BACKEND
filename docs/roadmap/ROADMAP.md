# C1RCLE-BACKEND — Full-platform roadmap (multi-session)

> Master index for the phased rebuild of the V2 backend toward full parity
> with the old `thec1rcle` monolith, scoped to match `C1RCLE-FRONTEND`.
> **Read this file first in any new session** (see also `docs/README.md` for
> the full documentation map). It supersedes the "frozen Auth + Organizations
> + Venues + Events, everything else BLOCKED forever" line in
> `docs/reference/frontend-api-map.md` — see `docs/architecture/decisions.md`
> D-008 for why and when that changed.
>
> Each phase has its own file in this directory: exact endpoints to build
> (grounded in real frontend needs, not guesses), the v1 business rules/
> formulas to port (with `thec1rcle` file references), Firestore collections
> to use, and a **Session Log** you must append to before ending a session
> that touched that phase. A future session (or subagent) should be able to
> resume from just this file + the relevant phase file, without re-auditing
> all three repos.

## How to use this (agent-driven workflow)

1. Read this table. Pick the lowest-numbered phase that is not `done`.
2. Open its phase file. Read the Session Log first — it has the most recent
   decisions and gotchas.
3. Do the work. Keep routes thin, storage behind interfaces, contracts
   backend-owned (see `docs/architecture/README.md` §5 and `task.md`
   §"Architecture rules" — these apply to every phase, not just Phase 0).
4. Before ending the session: update the phase file's checklist and append a
   dated Session Log entry (what was built, what was decided, what's still
   open). Update the status in the table below.

## Phases

| # | Phase | Status | File |
|---|---|---|---|
| 0 | Foundation — Firestore persistence, Better Auth, close out Org/Venue/Event routes, path-shape fix | **done** (2026-08-13, live-verified against real Firestore) | [phase-00-foundation.md](phase-00-foundation.md) |
| 1 | Partner dashboards — Host/Venue/Promoter overview+events+finance+analytics, RBAC/tab-visibility, partnerships | **substantially done** (2026-08-13); finance blocked on Phase 6 | [phase-01-partner-dashboards.md](phase-01-partner-dashboards.md) |
| 2 | KYC / Onboarding — document upload, admin approval workflow, verification provider | **substantially done** (2026-08-14); storage-upload signing deferred | [phase-02-kyc-onboarding.md](phase-02-kyc-onboarding.md) |
| 3 | Event-catalog & scheduling — ticket tiers/promo/tables/promoter-assignment routes, slot-requests, calendar | **done** (2026-08-13) | [phase-03-event-catalog-scheduling.md](phase-03-event-catalog-scheduling.md) |
| 4 | Guest checkout & tickets — discovery/directory, pricing, Razorpay checkout, promo codes, entitlement/QR, wallet | **done** (2026-08-19) — domain + HTTP wiring complete, 302 tests pass | [phase-04-guest-checkout-tickets.md](phase-04-guest-checkout-tickets.md) |
| 5 | Door / Scanner / Cover-wallet — entitlement scan + magic-ticket QR, walk-in/dine-in, cover-charge wallet | not started | [phase-05-door-scanner-cover-wallet.md](phase-05-door-scanner-cover-wallet.md) |
| 6 | Finance / Ledger / Payouts — settlement engine, bank accounts, disputes, T+3 batch | not started | [phase-06-finance-ledger-payouts.md](phase-06-finance-ledger-payouts.md) |
| 7 | Admin console backend — tiered-authority approvals, propose→resolve, audit log | not started | [phase-07-admin-console.md](phase-07-admin-console.md) |
| 8 | Social / discovery / notifications — follow graph, chat, notification fan-out | not started | [phase-08-social-notifications.md](phase-08-social-notifications.md) |

## Non-negotiable rules across every phase

(Full detail: `docs/architecture/README.md`, `docs/architecture/decisions.md`, `task.md` "Architecture rules")

- Single network boundary: frontend → `@c1rcle/api-client` → Fastify `/api/v2` gateway only. No app-local business routes, no direct Firestore from the frontend.
- Route = thin (validate → auth → scope → one service call → serialize). No `.collection(`/`.doc(` outside `packages/core/src/infrastructure/**`.
- Storage stays behind `domain/ports/repositories.ts` interfaces — services/routes never know which adapter is live.
- Contracts are backend-owned (`packages/contracts`); the frontend copy catches up, never the reverse.
- BLOCKED = absent (404 by absence), never a 501 stub, until its phase actually lands.
- Every write is idempotent (`Idempotency-Key`) and optimistically locked (`If-Match`).
- Cross-tenant access fails closed (`requireOrgAccess`, IDOR-safe 404s).

## Source-of-truth map (where to look before inventing anything)

| Question | Look here first |
|---|---|
| What does the frontend actually call/expect for domain X? | `C1RCLE-FRONTEND` — fixtures/models in `apps/partner-dashboard/src/components/**`, `apps/guest-portal/src/features/**/types/*.types.ts`, `apps/partner-dashboard/src/lib/partner/{contracts,api-partner-repositories}.ts` |
| What's the proven v1 business rule/formula for X? | `thec1rcle` — see per-phase file for exact paths (auth, RBAC, finance, entitlements, cover-wallet, etc. are all mapped out already) |
| What's the target V2 route shape/policy? | `C1RCLE-BACKEND/docs/reference/route-manifest.ts` + `API_V2_ROUTE_MANIFEST.md` (full-platform target manifest, PLANNED/BLOCKED status per route) |
| What's already decided vs still open? | `C1RCLE-BACKEND/docs/architecture/decisions.md` |
