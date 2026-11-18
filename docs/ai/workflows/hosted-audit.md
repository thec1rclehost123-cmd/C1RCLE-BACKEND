# Hosted audit

Use for approved comprehensive acceptance of deployed Guest, Partner, Promoter, Scanner, Admin or integrated workflows. Claude normally leads the browser work; use the real hosted product as the primary evidence source.

1. Confirm the approved scope, environment and safety/authorization boundary. Establish deployed frontend and backend revisions from deployment evidence; record unknown revisions as unknown. Do not substitute a local or merged revision for deployed proof.
2. Read only the relevant items in `ACCEPTANCE_STATE.json`, open/related records in `FINDINGS.json`, and suitable records in `STAGING_FIXTURES.json`. Consult `CHANGE_IMPACT.json` to determine which existing PASS evidence still applies. Read `C1RCLE_CONTEXT.md` only for domain context needed by the scenario.
3. Select an established fixture. Use READY fixtures when appropriate; verify NEEDS_VERIFICATION records before use. A requirement is not usable until separately provisioned, bound and promoted. Record the fixture and every object created or mutated. Preserve account/session continuity and reconcile the same object through the workflow.
4. Exercise realistic role journeys in the hosted browser first: authenticate, switch roles/accounts as required, navigate, submit, RSVP/apply/claim/buy, decide requests, use referral links, scan or inspect admin state. Reconcile API/network or persisted state only where needed to substantiate the observed result. Do not replace browser acceptance with source inspection.
5. Reuse unaffected PASS evidence. Record concise PASS/FAIL/PARTIAL/BLOCKED/UNTESTED/DEFERRED outcomes. Capture expected/observed behavior, affected state, reproducibility and likely boundary when cheap. Record P2/P3 and continue safely. Stop the risky scenario on credible P0/P1 or an authorization/provider boundary; identify the minimum owner action. Never perform an unauthorized payment, refund, destructive action or real-data test.
6. Do not deep-dive source during broad coverage unless needed to classify or explain a reproduced result. Report the acceptance matrix, state/provider reconciliation, findings/debt, blockers and exact next action. Identify which harness records need an authorized update.

For interruption, checkpoint only: workflow; environment; deployed frontend/backend revisions or unknown; account/role label (no credentials); fixture IDs; created/mutated object IDs; completed acceptance items; open findings; current browser/workflow position; provider or human action pending; exact next action. Resume from the checkpoint after rechecking environment, session and fixture state.

Use `pnpm acceptance:checkpoint` at meaningful setup, mutation, major-section, handoff or interruption boundaries; do not checkpoint every click. Resume by reusing Step 10 preparation and rechecking state before continuing.

## Result

`AUDIT RESULT`; `DEPLOYED REVISIONS`; `P0/P1`; `P2/P3`; `ACCEPTANCE OUTCOMES`; `STATE/PROVIDER RECONCILIATION`; `BLOCKED/UNTESTED/DEFERRED`; `NEW/REGRESSED FINDINGS`; `HARNESS UPDATES REQUIRED`; `NEXT ACTION`.
