# C1RCLE Level 7 Launch Certification

[`../LAUNCH_CERTIFICATION.json`](../LAUNCH_CERTIFICATION.json) is the current certification state. This system decides whether an **exact, owner-approved Release Candidate and its production-intended configuration** have sufficient evidence for launch. It does not define product scope, deploy, activate providers or authorize production release.

The JSON Schema at [`launch-certification.schema.json`](launch-certification.schema.json) rejects unknown fields and shapes. It is structural validation, not a decision engine. The owner/certification team must apply this decision rule and keep the state linked to actual evidence.

## Scope and evidence ownership

First record the owner-approved launch scope and exclusions. Certify only features and journeys in that scope; conditional domains/journeys stay unresolved until the scope decision is recorded. Roadmap examples do not add product requirements.

`ACCEPTANCE_STATE.json` remains the detailed evidence ledger; `FINDINGS.json` remains the defect ledger; `STAGING_FIXTURES.json` remains the fixture catalog; `CHANGE_IMPACT.json` maps changes and consumers; `TESTING_CADENCE.md` selects the level and breadth. Certification stores references, RC applicability, readiness, blockers, dispositions and approvals—not copied test reports. Update the evidence ledger with checks actually performed, then reference those records here. Evidence provenance links use stable item IDs and name the candidate they apply to; keep the detailed revision/time/source record in the owning ledger.

The JSON starts at `NOT_READY_FOR_CERTIFICATION`. It records current harness prerequisites: no exact RC or approved launch-scope reference, Guest remediation and targeted re-acceptance remain open, Partner acceptance is pending, Access/Tickets and dedicated Promoter/Scanner passes are incomplete, broad audits remain ahead, production fee policy approval is not recorded, and production configuration/rollback are unverified. The initial Findings summary has no P0/P1 and seven P2 findings as of its recorded source date; reassess launch relevance and severity against the candidate rather than treating that snapshot as current RC clearance.

## Exact candidate and configuration

Before certification, identify the candidate label/version and exact frontend SHA for each deployed surface, backend SHA, Scanner build/version when in scope, deployment references and provenance. A merge is not deployment proof. If a revision cannot be proven, keep it unknown and do not mark affected evidence PASS. Record the certification start/end, evidence cutoff, certification owner and technical approver as role labels, not personal signatures.

Capture the production-intended configuration by a safe reference or fingerprint where available. Each configuration check records readiness, evidence reference, version/fingerprint, verifier role and time. Never store secret values, tokens, private data or payment-card information. Verify secret presence through an approved mechanism and record only a safe reference. A Vercel/Render/Firebase/Razorpay/Resend/OAuth/webhook value is not made safe by copying it into this file.

Keep application behavior evidence separate from production provider configuration. Razorpay Test Mode may support staging checkout behavior; it does not prove Live credentials, production webhook target, capture configuration, approved production fee policy or owner authorization. Step 14 does not activate Live Mode. A real-money transaction is not automatically required; the approved certification plan decides whether one is necessary. Production fee policy approval is mandatory for GO. Do not invent fee percentages. Confirm the approved settlement/payout model; if payouts are intentionally manual or disabled, verify safe disablement and documented operations, without implying automatic payouts.

Production readiness also covers the domains listed in the JSON: domains/deployments, Firebase/Auth, Firestore rules/indexes, required secret presence, email/OAuth, monitoring/error capture, rate limits where applicable, backup/recovery and rollback. Require enough visibility to detect critical payment, webhook, server and admission failures; no enterprise observability stack is implied. Block for repeated critical-flow timeouts, unusable checkout/Wallet, severe request storms or critical browser crashes; do not invent enterprise SLOs. Certify critical mobile journeys on representative real mobile/runtime behavior where required; desktop viewport resizing alone is not mobile certification.

Rollback readiness identifies previous known-good frontend/backend releases, procedure, authorized operator role, data-migration considerations and provider/configuration rollback. Document and verify the path; do not execute rollback as part of certification design.

## Domains, journeys and status

The active record has eleven domains: Guest; Partner; Access/Tickets; Promoter; Scanner/Door; Admin; Payments/Money Integrity; Security/Privacy; Cross-role/Cross-system; Runtime/Operations; Critical Experience. It also has five same-object journeys: paid Guest to admission; Host/Venue publication; free or approved access to admission; Promoter-attributed order; cancellation or material change. Scope markers prevent future or unapproved capabilities from being treated as launch requirements.

Each domain and journey carries a status, required evidence, acceptance/finding references, exact-RC applicability, evidence provenance, last verification time, blockers and waiver (domains only). Use the statuses consistently:

- `NOT_READY`: a prerequisite or planned pass is incomplete.
- `UNTESTED`: no qualifying result exists for the stated scope.
- `BLOCKED`: a missing prerequisite prevents the check; this is not a defect PASS.
- `PARTIAL`: some evidence exists, but required scope is uncovered; never count it as PASS.
- `PASS`: required evidence passes and is applicable to this exact RC/configuration.
- `FAIL`: evidence demonstrates a required behavior/control failed.
- `DEFERRED`: explicitly postponed with disposition; it cannot silently disappear or satisfy GO.

Historical PASS may be linked as `HISTORICAL_SUPPORTING_ONLY`. It can guide preparation, but cannot certify the exact RC. `EXACT_RC` requires evidence to identify `candidate_ref`, revisions, environment and relevant configuration. Keep provenance details in Acceptance State where possible and store only a reference and applicability here.

## Exact-RC and hard-gate policy

Level 7 deliberately re-exercises critical paths that normal cadence would let reuse historical PASS evidence. Fresh exact-RC evidence is normally required for auth/session, paid checkout, inventory/fulfillment, access/ticket entitlement, QR/Scanner admission, Host/Venue publication, critical authorization/isolation and major provider/runtime configuration. Critical Journey A–E evidence is fresh when that journey is in approved scope. Minor visual details do not need blanket retesting; use Change Impact and Testing Cadence to target changed areas.

The following rules are non-negotiable:

- Any open launch-relevant P0 is `NO_GO`; no waiver.
- Any open launch-relevant P1 is normally `NO_GO`. A rare P1 waiver requires explicit owner approval, rationale, bounded exposure, mitigation and expiry/review point. Never waive a P0, known money corruption or critical security bypass. Money-integrity and security P0/P1 remain hard `NO_GO` gates.
- Every launch-relevant P2 needs an explicit disposition: fix before launch, accepted launch risk, feature disabled, operational mitigation or deferred with rationale. Accepted risk needs explicit owner approval and a review/expiry point. P2 does not automatically mean NO-GO, but an absent disposition blocks GO.
- P3 may become post-launch debt unless it undermines a critical journey or safety control.
- Incorrect/duplicate charges or fulfillment, inventory corruption, fee/tax mismatch, unauthorized refund, ambiguous payment confirmation or severe reconciliation failure blocks GO.
- Required auth bypass, IDOR/cross-org access, sensitive Guest data exposure, QR or payment-verification bypass, critical Admin authorization failure or secret exposure blocks GO.
- Required domains and in-scope critical journeys must PASS. `PARTIAL`, `BLOCKED`, `UNTESTED`, `NOT_READY` and `DEFERRED` never count as PASS.

Waivers are not a normal path. The schema supports only P1 waiver records with an owner role label, rationale, bounded exposure, mitigation and expiry/review point; it does not support a P0 waiver. A waiver does not change a failed evidence record or waive a money/security hard gate. If a waivable residual P1 remains, a required domain may PASS only when its required evidence passes and the approved waiver is current; the residual risk remains visible in the report.

## Deterministic decision rule

1. **`NOT_READY_FOR_CERTIFICATION`** when exact RC identity or approved scope is missing, major launch implementation/prerequisites are unfinished, required evidence has not been collected, or a required build/surface is unavailable. This is the initial state.
2. **`NO_GO`** when a required domain or critical journey fails; a launch-relevant P0/P1 or money/security hard gate is open; or production configuration is known unsafe/incomplete in a launch-blocking way. A concrete failure is not relabeled “not tested.”
3. **Technical `GO`** only when candidate and production-intended configuration are exactly identified; launch scope is approved; every required domain and in-scope critical journey passes on the exact RC; required production configuration, fee policy, settlement model, monitoring and rollback are ready; findings are reviewed with every relevant P2 dispositioned and no unapproved P1/P0; and no required item is blocked, partial, deferred or untested.

If a check is `BLOCKED` because evidence or a build is unavailable, keep the certification `NOT_READY_FOR_CERTIFICATION`; if the evidence establishes that a required production control cannot safely operate, record `NO_GO`. Neither outcome permits launch. An approved conditional feature marked `OUT_OF_SCOPE` must cite the scope exclusion; do not use scope labels to hide failed required behavior.

`certification_status` is the technical decision; record it separately from `owner_launch_approval`. Technical `GO` is a recommendation, not deployment or launch authority. Production release still requires explicit owner authorization.

## Workflow

1. Establish the exact RC and deployment provenance for all in-scope surfaces; freeze the candidate and capture its configuration reference/fingerprint.
2. Record approved launch scope and exclusions, including conditional domains and journeys.
3. Run Step 10 preparation for the intended environment; review current findings and verify required fixtures/readiness.
4. Execute the approved Level 7 plan using Claude/browser and required provider or cross-role evidence. Do not use a provider action without explicit authorization. Use Step 11 checkpoints for long sessions.
5. Update Acceptance State with actual evidence and provenance; link those records from domains/journeys. Do not copy evidence wholesale.
6. Review findings against the exact RC, record severity/launch relevance and resolve P0/P1/P2 gates. Re-certify affected areas after fixes using Change Impact plus Testing Cadence; do not rerun everything automatically.
7. Calculate the technical decision, produce the report view below, and have the owner review it. Only then can the owner separately record explicit launch approval. Deployment/release remains a separate operation.

Changes after certification—including code SHA, production config/provider changes, critical new findings, rollback/redeploy to another revision, security incident or material environment drift—invalidate affected evidence. A changed candidate is not the same certified RC. Use Change Impact and Testing Cadence to target recertification; retain the old decision as historical support rather than automatically repeating every check. Withdraw or re-request owner launch approval after invalidation; it cannot carry over to a different candidate.

## Report view

Use this compact summary for owner review:

```text
RC — <label/version; frontend/backend/scanner identities>
TECHNICAL DECISION — <GO / NO-GO / NOT READY FOR CERTIFICATION>
OWNER LAUNCH APPROVAL — <NOT REQUESTED / PENDING / APPROVED / DENIED>
GUEST — <status>   PARTNER — <status>   ACCESS/TICKETS — <status>
PROMOTER — <status>   SCANNER — <status>   ADMIN — <status>
PAYMENTS — <status>   SECURITY — <status>   CROSS-SYSTEM — <status>
RUNTIME/OPS — <status>   CRITICAL UX — <status>
P0 OPEN — <count>   P1 OPEN — <count>   P2 DISPOSITIONS — <summary>
BLOCKERS — <list>   PRODUCTION CONFIG — <status>   ROLLBACK — <status>
GO CONDITIONS REMAINING — <list>
```

## Current state and history

`LAUNCH_CERTIFICATION.json` is the active candidate record and currently means **not ready**, not a negative certification of a specific RC. Update it only as evidence is collected; do not change its initial status to imply readiness from milestone history. After a certification is finalized, the team may copy an immutable dated/RC-specific snapshot under `docs/ai/launch-certification/history/`. No history file or database is created by this design step.
