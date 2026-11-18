# Targeted re-acceptance

Use after a bounded deployed fix to verify the finding without repeating a comprehensive audit. Claude normally leads the hosted browser work.

1. Load the exact finding from `FINDINGS.json`, its linked acceptance item(s) from `ACCEPTANCE_STATE.json`, and the relevant area(s) in `CHANGE_IMPACT.json`. Read only the records needed to understand the claimed behavior, closure rule, direct dependencies and retest scope.
2. Select any linked record from `STAGING_FIXTURES.json`. Check readiness, mutability, reservation, contamination and current state. If only a requirement exists, it is not usable: arrange approved provisioning/binding and verification separately. Do not invent a locator. Identify relevant unaffected PASS evidence and why it remains applicable.
3. Establish the deployed fix revision(s) using deployment evidence, and confirm they include the intended change. Keep local/CI evidence distinct. If deployment provenance is unknown, report that and withhold revision-specific acceptance claims.
4. Use the hosted browser to execute only the original failed behavior and directly affected boundaries identified by Change Impact. Reconcile the same event/request/order/ticket and persisted state where relevant. Include provider participation only if the original finding requires it and the action is separately authorized. Do not expand to unrelated journeys.
5. Classify the target as PASS, FAIL, PARTIAL, BLOCKED or UNTESTED. Preserve unaffected PASS evidence rather than repeating it. Record evidence and fixture mutations. Close the finding only if its documented closure rule is satisfied by deployed targeted verification; otherwise keep it open and state the missing condition. A regression retains the permanent finding ID.

For interruption, checkpoint only: workflow; environment; deployed frontend/backend revisions or unknown; account/role label (no credentials); fixture IDs; created/mutated object IDs; completed acceptance items; open findings; current browser/workflow position; provider or human action pending; exact next action. Before resuming, confirm the deployment, session and fixture state still apply.

Use `pnpm acceptance:checkpoint` at meaningful setup, mutation, major-section, handoff or interruption boundaries; do not checkpoint every click. Resume by reusing Step 10 preparation and rechecking state before continuing.

## Result

`FINDING`; `DEPLOYED FIX`; `TARGETED SCOPE`; `RESULT`; `RELATED PASS EVIDENCE PRESERVED`; `STATE RECONCILIATION`; `FINDING CAN CLOSE — YES/NO`.
