# C1RCLE Codex instructions

## Start with the relevant harness records

This repository owns the cross-repo Agent Harness in `docs/ai/`. Classify substantial work first and retrieve only the sections or records it needs. Consult applicable nested `AGENTS.md` files for local rules. The workflow works with ordinary Git and targeted source search.

- **Architecture** — Start with [C1RCLE_CONTEXT.md](docs/ai/C1RCLE_CONTEXT.md). Inspect current source when exact behavior matters. Report conflicts between source and the map, and stop for an owner decision if source contradicts locked product policy.
- **Bug remediation** — Start with [FINDINGS.json](docs/ai/FINDINGS.json) and reuse the permanent finding ID. Read the affected acceptance items and impact areas. Look up fixtures only if staging verification is needed.
- **Milestone implementation** — Read the project map, approved milestone specification and relevant impact areas. Retrieve acceptance evidence and findings that affect the milestone.
- **Hosted re-acceptance** — Start with [ACCEPTANCE_STATE.json](docs/ai/ACCEPTANCE_STATE.json), then select the related findings, fixture records and impact areas. Keep local tests, CI, deployed API, browser, provider and cross-role evidence distinct.

Prefer these pointers over reconstructing history from old chats, logs, milestone documents or broad Git searches. Use existing hosted evidence for established symptoms, responses and state transitions. Trace current code only as far as needed to identify the responsible boundary and explain the failure. Once the evidence supports the fix, stop investigating. For a bounded defect, use the existing reproduction, add a focused regression check where appropriate, and make the smallest coherent fix.

## Worktree and scope

- Before editing, verify the repository, branch, approved baseline SHA and worktree cleanliness. Implement in an isolated clean worktree from that baseline. Preserve unrelated dirty checkouts, old milestone worktrees and other agents' active work. Avoid resets and cleanup of user changes.
- Stay inside the approved milestone and task. Record unrelated debt and defer it. Escalate genuine blockers, security or integrity emergencies and meaningful scope expansion. Keep the approved milestone boundaries and sequence.
- When the backend provides the contract, change it first, then update the frontend consumer. Run contract parity against the exact paired heads. Keep product truth in its owning layer and avoid temporary compatibility shims for branch checks.

## Retest and verify

Before broad validation on a non-trivial diff, use [CHANGE_IMPACT.json](docs/ai/CHANGE_IMPACT.json) to write a short retest plan covering affected areas and risk, at-risk and preserved acceptance, findings, fixtures, focused local checks, CI gates, and any hosted, provider or cross-role checks. Trace actual consumers of shared changes. Preserve unrelated PASS evidence, check applicability to the current revision and follow the acceptance ledger's invalidation, expiry and recertification rules.

Run the smallest relevant test, typecheck, lint or emulator check while implementing. Batch related fixes. Run the required comprehensive CI-equivalent gate once on the final intended milestone or PR diff. If it finds routine formatting, import or lint failures, fix them together and rerun the failed or relevant gate where repo policy permits. Repeat the full suite when the change or policy requires it. GitHub CI is the deterministic packaging gate. Record hosted acceptance separately for the workflow and revisions actually exercised.

## Staging, security and owner authority

Use [STAGING_FIXTURES.json](docs/ai/STAGING_FIXTURES.json) to select verified, appropriately mutable synthetic fixtures. A requirement needs authorized provisioning or binding and verification before use. Check reservations and prior mutations. Preserve historical orders and consumed or contaminated fixtures. Shared staging mutations, manual Firestore repairs, payments, refunds, SMS, email and environment or provider changes require explicit authorization for the action.

Preserve authorization, session security, CSRF and cross-account isolation, QR eligibility, payment verification, quantity and inventory enforcement, and security gates. Investigate failed security checks. Escalate any proposed exception, security weakening or waiver to the owner.

Stop at the approved delivery boundary. PR preparation, merge, staging deployment and production release are distinct actions. Merge and deploy require explicit authorization, and production always requires owner approval. Ask before production policy or fee decisions, actions outside staging/provider authorization, major dependency upgrades, broad architecture changes or material scope expansion.

## Record evidence and stop at blockers

When authorized to maintain the harness, update only affected records. Record verified progress from investigation and fix through PR, merge, deployment and re-acceptance. Close hosted findings only under the finding ledger's closure rule. Update the acceptance evidence for verified checks and the fixture state after authorized mutation. Preserve finding IDs, historical evidence and locked harness semantics.

For substantial work, report established causes, consequential decisions, meaningful blockers, verification and scope or risk changes. Summarize what changed, which checks ran, what remains unverified and any decision required. Stop the affected work when authority, a safe fixture or access is missing, a locked policy conflicts with source, or the fix requires an unsafe workaround or unapproved migration. State the specific blocker and minimum action needed.
