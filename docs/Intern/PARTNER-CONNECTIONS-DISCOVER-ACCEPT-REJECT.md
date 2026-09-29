# Partner Connections: Discover + Accept/Reject Fix

**Date:** 2026-09-16
**Scope:** Partner-network tab of the partner dashboard (Discover view, Requests accept/reject/withdraw, partner names)
**Repos touched:** `C1RCLE-BACKEND` (gateway + core + contracts), `C1RCLE-FRONTEND` (generated contracts mirror only — byte-identical, no content change)

Both dashboard surfaces — the legacy per-studio screens
(`C1RCLE-FRONTEND/apps/partner-dashboard/src/components/venue/screens/PartnersScreen.tsx`,
used by `/venue|host|promoter/partners`) and the v3 `StudioPartnersClient`
(`components/partner-v3/partners/`, used by `/partner/[studio]/partners`) —
call the same gateway endpoints via `lib/api/partner-connections.ts` and
`lib/api/partner-discover.ts`, so every fix below covers both UIs at once.

---

## 1. Problems

### P1. Discover tab was empty by construction (404, not by data)
The dashboard calls `GET /api/v2/organizations/:id/discover-partners`, but **no
such route existed** on the gateway. `fetchDiscoverSet`
(`data/api-partner-data-source.ts:297`) uses `Promise.allSettled` and silently
drops rejections, so every 404 read as "no partners". The tab could never show
anything regardless of database content. The contract schemas
(`discoverPartnerDtoSchema`, `discoverPartnersQuerySchema`) existed only in the
*frontend* contracts copy — the backend-owned source never had them.

### P2. Venue→host invites always failed ("cannot partner with itself")
`POST /partnerships` with `{ initiatedBy: 'venue', hostOrganizationId }`
failed every time: the route validated `hostOrganizationId` but **dropped it
before calling the service**, and the service defaulted the host side to the
venue's own org — tripping the domain's self-partnership guard. The happy path
had no test (only the non-owner 403 case), which is how it survived.

### P3. Accept/Reject returned 403 for `member`-role counterparties
Partnership answer routes required `venue.manage`, which `member` roles don't
hold — so an invited org's staff saw Accept/Decline fail with a 403 that read
as "accept is broken". Promoter-connection answers already needed only
`organization.read`; partnerships were inconsistent with them.

### P4. "Cancel request" (Sent tab) failed on pending partnerships
Withdrawing a sent request posts to `POST /partnerships/:id/end`, but the
domain FSM forbade `pending → ended`, so every withdrawal errored. (Promoter
`revoke` from pending was already legal.)

### P5. Every partner rendered as `Host A1B2C3` (fabricated-looking names)
List DTOs carried no names although the UI expects
`hostName/venueName/promoterName/targetName/…`. The frontend fell back to
ID-derived labels for every row even when the real names existed in storage.

---

## 2. Solution implemented

### S1. New `GET /organizations/:organizationId/discover-partners`
- **Service** `packages/core/src/application/partnerships/partner-discovery-service.ts`
  (new, exported from `application/index.ts`, wired as `discovery` in
  `apps/api-gateway/src/lib/v2-services.ts`): browses active orgs/venues,
  filters by kind (union of member capabilities), search text, and id-offset
  cursor; excludes self and live counterparts so "Send Request" can't 400 as
  "already requested". All backing reads are bounded (`BROWSE_CAP = 200`) and
  filtering happens in code — **no new Firestore composite indexes**.
  `verified` is always `false` (no org-verification concept exists yet).
- **Repos** (`domain/ports/repositories.ts` + memory + Firestore org/venue
  adapters): new bounded `listActive(limit)` browse reads (single-field
  `status == 'active'` queries + in-code filtering).
- **Route** `apps/api-gateway/src/routes/v2/partner/discover.ts` (new,
  registered in `route-manifest.ts`): `organization.read` permission,
  `discoverPartnersQuerySchema` validation, paginated response.
- Known edge (documented in code): a host already partnered on one of your
  venues is hidden from Discover even though it could partner on a second
  venue — accepted v1 tradeoff, far better than 400-on-click.

### S2. Venue-initiated invites carry the host org through
- `RequestPartnershipCommand.hostOrganizationId?` added
  (`application/partnerships/partnership-service.ts`); venue-initiated uses it
  (missing → `InvalidOperationError`), host-initiated still uses the actor's org.
- Route forwards `body.hostOrganizationId`; contract schema requires it for
  `initiatedBy: 'venue'` via `superRefine` (422 otherwise).

### S3. Answer permission lowered for approve/reject
- `partnerships.ts registerAction` takes a permission; **approve/reject → 
  `organization.read`**, block/end stay on `venue.manage`. The domain still
  enforces *which* org may answer (counterparty only).

### S4. Requester may withdraw a pending request
- Domain FSM: `pending → ended` added, but `endPartnership` rejects the
  *counterparty* ending a pending request (`InvalidOperationError` — they must
  approve/reject). Terminal states unchanged.

### S5. Server-side name enrichment on list reads
- New `listWithNames` on `PartnershipService` / `PromoterConnectionService`
  (bounded per-row org/venue lookups, `null` when the counterparty is deleted —
  the UI's existing ID-label fallback); routes serialize the new nullish DTO
  fields. Single-item writes keep `null` names (dashboard refetches the list).

### Contracts sync
- Backend `packages/contracts/.../partner.ts` gained the enrichment fields +
  discover schemas; `index.ts`/`client.ts` export them. `export-contracts.mjs`
  re-run — frontend mirror verified **byte-identical** (the additions were
  ported verbatim from it), so zero frontend content churn. `contract-parity`
  shows only the 4 pre-existing venue/event drifts.

---

## 3. Files changed

**Backend — gateway (`apps/api-gateway/src/`):**
- `routes/v2/partner/discover.ts` **(new)** + `discover.test.ts` **(new, 6 tests)**
- `routes/v2/partner/partnerships.ts` — forward `hostOrganizationId`;
  approve/reject permission; enriched list mapping
- `routes/v2/partner/partnerships.test.ts` — venue-invite happy path + 422,
  non-owner 403 fix, enrichment assertions, withdraw tests (2)
- `routes/v2/partner/promoter-connections.ts` — enriched list mapping
- `routes/v2/route-manifest.ts` — register discovery routes
- `lib/v2-services.ts` — wire `discovery` service

**Backend — core (`packages/core/src/`):**
- `application/partnerships/partner-discovery-service.ts` **(new)**
- `application/partnerships/partnership-service.ts` — `hostOrganizationId`
  command field; `listWithNames`
- `application/promoters/promoter-connection-service.ts` — `listWithNames`
- `application/index.ts` — export new service + types
- `domain/models/partnership.ts` — `pending → ended` transition + requester-only
  withdraw guard
- `domain/partnership.test.ts` — withdraw tests (2, replacing the outdated
  "cannot end something never active" case)
- `domain/ports/repositories.ts` — `listActive` on org + venue repos
- `infrastructure/memory/memory-repositories.ts`,
  `infrastructure/firestore/firestore-organization-repository.ts`,
  `infrastructure/firestore/firestore-venue-repository.ts` — `listActive` impls

**Backend — contracts (`packages/contracts/src/`):**
- `contracts/partner.ts`, `index.ts`, `client.ts` — enrichment fields, discover
  schemas + exports (mirrored to frontend, zero diff)

**Frontend:** no content changes (contracts mirror only).

---

## 4. Verification

- Gateway suite: **328/328** (37 files, incl. new `discover.test.ts`)
- Core suite: **436/436**; contracts suite: **13/13**
- Dashboard partners/v3/data/api suites: **66/66** (UI contract untouched)
- `tsc --noEmit` clean (core, contracts, gateway); `eslint` clean on all
  touched files; contract-parity adds no new issues
- Manual check after restarting the gateway dev server: Discover tab lists real
  orgs/venues; venue→host invite creates `pending`; counterparty (incl.
  `member` role) Accept/Reject resolves it; Sent → Cancel withdraws (`ended`);
  partner rows show real names.
