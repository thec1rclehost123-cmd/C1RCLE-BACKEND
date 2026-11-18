# Cross-role / cross-system acceptance

Use only when one business object must be followed across distinct C1RCLE actors or product surfaces, such as Host → Venue → Guest publication or Promoter → Guest → Scanner. Claude normally leads the coordinated hosted exercise.

1. Confirm approved scope, environment, actors, permitted actions and any provider authorization boundary. Select a suitable established fixture from `STAGING_FIXTURES.json`; verify readiness and mutation safety. If no usable fixture exists, consult `requirements` and stop that scenario until separately provisioned, bound, verified and promoted.
2. Assign and record the exact event, request, order or ticket identity before changing roles. Use separate accounts/sessions where required and label each by role, never by secret. Preserve the same identity across every actor and surface; unrelated examples do not constitute a cross-role journey.
3. For each transition, exercise the actual hosted UI for the actor, verify allowed actions and representative denied actors, then reconcile the persisted object before moving to the next actor. Record expected and observed state at each boundary and where any state diverges. Avoid broad source inspection; use targeted API/state reads only to reconcile behavior.
4. Include a payment provider only when separately authorized. A Guest payment journey alone is provider evidence, not cross-system acceptance. Never use real customer data or perform a refund, destructive action or provider mutation outside the approved scope.
5. Record per-transition outcomes, evidence provenance, fixture/object mutations, blockers and any finding. Stop unsafe transitions on credible P0/P1. Keep P2/P3 observations and continue where safe. Update acceptance/finding/fixture records only when authorized; preserve unrelated PASS evidence.

For interruption, checkpoint only: workflow; environment; deployed frontend/backend revisions or unknown; account/role label (no credentials); fixture IDs; created/mutated object IDs; completed acceptance items; open findings; current browser/workflow position; provider or human action pending; exact next action. On resume, reacquire the same object identity and verify state/session before proceeding.

Use `pnpm acceptance:checkpoint` at meaningful setup, mutation, major-section, handoff or interruption boundaries; do not checkpoint every click. Resume by reusing Step 10 preparation and rechecking state before continuing.

## Result

`SCENARIO`; `DEPLOYED REVISIONS`; `OBJECT IDENTITY`; `ROLE TRANSITIONS`; `ALLOWED/DENIED ACTORS`; `STATE RECONCILIATION`; `PROVIDER/HUMAN ACTION`; `FINDINGS`; `BLOCKED/UNTESTED`; `NEXT ACTION`.
