# Phase 7 — Admin console backend

**Status:** not started · **Depends on:** Phase 2 (onboarding approvals), Phase 6 (financial actions)

`C1RCLE-FRONTEND/apps/admin-console` is currently an empty scaffold (one
static marketing-style page, no routes, no data — confirmed by full read
during this session's research). This phase is backend-first; the frontend
has essentially nothing to preserve or migrate.

## v1 proven logic to port (`thec1rcle`, `apps/admin-console/lib/server/adminStore.js`)

- Already detailed in Phase 2 (onboarding approvals share this module):
  tiered authority (TIER1/2/3), propose→resolve dual control, mandatory
  before/after-state audit log on every mutation.
- Beyond onboarding: venue suspend, financial refund approval, payout batch
  run, commission adjustment, admin provisioning, partner-type
  reprovisioning (`partnerReprovision()` — deactivates old memberships,
  creates correct entity + membership + claims for a misclassified partner).

## Firestore collections

Shared with Phase 2: `v2_admins`, `v2_admin_audit_logs`, `v2_proposed_actions`.
New: `v2_support_tickets`, `v2_safety_reports`, `v2_platform_announcements`.

## Session Log

(none yet)
