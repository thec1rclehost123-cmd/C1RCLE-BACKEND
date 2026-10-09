# Team Member Add (Venue + Host): 500 Fix

**Date:** 2026-10-02
**Scope:** Add-staff invite flow on the venue and host dashboards (Staff tab → Add staff → Send invite)
**Symptom:** `Request failed with status 500.` on every invite, for both venue and host orgs
**Repos touched:** `C1RCLE-BACKEND` only (no frontend change needed)

Both dashboards call the same endpoint via `staffApi.createInvitation`
(`POST /api/v2/organizations/:id/invitations` with `capabilities: ['venue']`
or `['host']`), so one backend fix covers both UIs.

---

## 1. Problem

### P1. Invite always 500'd on the firestore driver (missing composite index)
`OrganizationService.createInvitation` first calls
`invitations.findPendingByEmail(organizationId, email)` as a duplicate guard.
The Firestore adapter ran a **triple-`where`** query
(`organizationId ==` + `email ==` + `status ==`), which needs a composite
index that was never declared in `firestore.indexes.json`. Firestore throws
`FAILED_PRECONDITION: query requires an index`, `mapDomainError` has no branch
for it, so it falls through to a generic 500. The memory driver and emulator
don't enforce indexes, so unit tests passed while prod 500'd on every invite.

### P2. Gateway couldn't boot — unresolved merge-conflict markers
Four files still contained `<<<<<<< Updated upstream` markers from the
staff-invitations merge, so `tsx`/esbuild failed to parse them:
`v2-services.ts`, `config/index.ts`, `route-manifest.ts`, `.env.example`.

### P3 (minor). Duplicate value in the user-directory `in` filter
`FirestoreStaffUserDirectory.findUserIdByEmail` sent
`where('email', 'in', [raw, normalized])`; an already-lowercase address sends
the same value twice. Fail-open today (service catches it), but worth
deduping.

---

## 2. Solution

- **S1.** Rewrote `findPendingByEmail` to a **single equality filter**
  (`where('email', '==', …).limit(50)`) and moved the org/status/expiry checks
  into code — same index-safe pattern `listPendingByEmail` already uses. No
  composite index or deploy needed.
- **S2.** Resolved all four conflict blocks, keeping the staff-feature side:
  `magicTicketSecret` + `partnerDashboardUrl` wiring in `v2-services.ts`,
  `PARTNER_DASHBOARD_URL` schema in `config/index.ts`, and the
  `services.auth` + `rotationStore` wiring in `route-manifest.ts`.
- **S3.** Deduped the `in` candidates in `findUserIdByEmail`.

---

## 3. Files changed (short)

| File | Change |
| ---- | ------ |
| `packages/core/src/infrastructure/firestore/firestore-invitation-repository.ts` | **The 500 fix.** `findPendingByEmail`: triple-`where` → single `email ==` filter + in-code org/status/expiry check. |
| `packages/core/src/infrastructure/firestore/firestore-staff-user-directory.ts` | Dedupe `in: [raw, normalized]` candidates. |
| `apps/api-gateway/src/lib/v2-services.ts` | Cleared conflict markers; kept `magicTicketSecret` + `partnerDashboardUrl` in `createCoreConfig`. |
| `apps/api-gateway/src/config/index.ts` | Cleared markers; kept `PARTNER_DASHBOARD_URL` schema + `ALLOW_MEMORY_STORAGE_IN_PRODUCTION`. |
| `apps/api-gateway/src/routes/v2/route-manifest.ts` | Cleared markers; kept `services.auth` + `rotationStore`/`organizations` wiring for `authContextPlugin` and `authRoutes`. |
| `apps/api-gateway/.env.example` | Cleared markers; kept `PARTNER_DASHBOARD_URL` doc entry. |

Pre-existing context (not changed here, verified safe): `createInvitation`'s
credential-provision and email-send steps are already fail-open (`try/catch`),
so only the duplicate-guard query could 500. RBAC is unchanged — only
`owner`/`admin` hold `staff.manage` (403 otherwise, by design).

---

## 4. Verification

- `organizations.test.ts` — 12 passed (invite + list-members flows).
- `organization-service.test.ts` + `invitation.test.ts` + `invitations.test.ts` — 30 passed.
- `firestore-invitation-repository.ts` typechecks clean in isolation.
- Full-repo `tsc --noEmit` still shows pre-existing staff-feature type errors
  (`plugins/auth.ts` `authUser` augmentation, `admin-ops-service.test.ts`
  missing new `ServiceDeps` fields) — runtime-agnostic under `tsx`, out of scope.

**Next step:** restart the gateway (`pnpm dev`) so the marker + query fixes load, then retry Add staff on venue/host.
