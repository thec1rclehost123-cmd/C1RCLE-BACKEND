# C1RCLE Claude Code guide

## Start with the task and the relevant records

This repository owns the common Claude guide and the Agent Harness under `docs/ai/`. Read selected sections or records on demand. Use applicable app guidance and the exact backend checkout, worktree or ref approved for the task. For paired work, match the approved backend baseline or head to the frontend and verify the deployed revisions separately. Establish a missing baseline from active worktrees or PR context. Report unresolved provenance and withhold revision-specific acceptance claims. Current backend `staging` is suitable when explicitly approved as the intended baseline or when reading stable guidance that needs no revision-specific evidence.

| Task | Start here |
| --- | --- |
| Hosted audit | Approved scope and [Acceptance State](docs/ai/ACCEPTANCE_STATE.json), then the relevant [findings](docs/ai/FINDINGS.json), [fixtures](docs/ai/STAGING_FIXTURES.json) and [change-impact areas](docs/ai/CHANGE_IMPACT.json). Read project context when needed. |
| Targeted re-acceptance | Exact finding, linked acceptance item, applicable fixture and relevant change-impact area. |
| Architecture or planning | [C1RCLE context](docs/ai/C1RCLE_CONTEXT.md) and the approved milestone or scope. |
| Failure investigation | Observed evidence, known finding and impact area, followed by the smallest relevant source trace. |

## Hosted audits start in the product

Establish the deployed environment and target revisions. Select a verified fixture and exercise the real product in a browser before inspecting implementation. Capture what happened, inspect only the network/API or persisted state needed to resolve the claim, and classify the result. Use exact deployed frontend/backend SHAs when verified. Record unknown revisions as `null` in the ledger and **UNKNOWN** in reports. A merged PR is insufficient deployment evidence. Time-box provenance work, qualify results that can safely proceed and block revision-specific claims when proof is missing.

Read source only to explain a reproduced failure, establish a security boundary that behavior alone cannot establish, inspect an exact contract or distinguish a product issue from deployment/provider configuration. For an explicit investigation, stop once the responsible boundary or best-supported classification is clear. Distinguish code, environment, provider, fixture and inconclusive results. An approved, available Code Review Graph may accelerate targeted source navigation. Ordinary targeted search and source inspection work without it. Skip graph-specific skills when the graph is unavailable or unapproved.

## Reuse evidence and choose the smallest re-acceptance scope

Reuse scoped PASS evidence unless relevant implementation, contract or configuration changed, later stronger evidence contradicts it, the evidence expired or the fixture/environment is no longer applicable, or the approved gate requires recertification. Use Change Impact to trace actual consumers and find the affected behavior, direct dependencies, safety boundaries and fixtures. Retain unrelated PASS evidence.

Keep local, CI, staging API, browser, provider, cross-role and cross-system evidence distinct. Stronger contradictory evidence controls the same claim. Keep lower-level results as supporting evidence. A browser PASS establishes the exercised journey and proves provider/webhook behavior only to the extent those paths were actually exercised.

Default to `TARGETED_REACCEPTANCE` after a bounded fix. Use `COMPREHENSIVE_HOSTED_AUDIT` at approved Guest/Partner or major integration gates, after Access/Promoter/Scanner integration, after approved Experience Quality implementation when broad risk warrants it, and for exceptional broad security or architecture changes where targeted checks are insufficient. The final adversarial launch certification can deliberately repeat critical PASS journeys.

## Protect fixtures and reconcile the same state

Search `fixtures` first. Verify readiness, mutability, reservation, contamination and critical current state before acting. A requirement needs separate authorized provisioning or binding, verification and promotion into `fixtures` before use. If no safe fixture exists, block that scenario and report the missing requirement. Use approved synthetic staging data for destructive acceptance, and ask before using real customer data for destructive tests.

Keep the canonical pricing event, historical paid booking and contaminated RSVP history intact. Preserve READ_ONLY records and use fresh disposable state for state-changing flows. Payments, refunds, Firebase verification, SMS, email and environment/provider changes require explicit authorization. Pause for any required owner action, including a human Test Mode payment step.

Reconcile the same event, request, order or ticket across actors and systems. For paid checkout, compare inventory before and after, confirmed order and Wallet entitlement. For RSVP, compare capacity through cancellation and re-claim, history and exactly one active entitlement. For slots, trace the selected window through the persisted request, Venue decision, slot, Host visibility and publication where applicable. Keep Accept and Decline on separate fixtures. For attribution or Scanner, follow the same relevant order or ticket.

## Triage, record and hand off

In comprehensive audits prioritize useful workflow coverage. Capture expected versus observed behavior, affected state, severity, reproducibility and the likely boundary when cheap to establish. Log P2/P3 findings and continue where safe. For a credible P0/P1 involving exposure, money or inventory corruption, unauthorized access, destructive state, unsafe provider behavior or another critical integrity risk, stop the risky scenario. Preserve evidence and report any mutation and the minimum safe next action. Stop other scenarios only if the failure blocks safe or meaningful testing.

Reuse permanent finding IDs. For a recurring closed defect use `REGRESSION` with the same ID. Update authorized records only. Report PASS, FAIL, PARTIAL, BLOCKED, UNTESTED and DEFERRED using the Acceptance State meanings. Preserve applicable prior evidence and separate failed behavior from missing prerequisites. Apply the finding closure rule after deployed targeted verification. Record any changed fixture state.

For performance work, capture time to useful content, fanout, duplicate requests, blocking waterfalls or slow/failing endpoints as relevant. For Experience Quality assess hierarchy, clarity, copy, loading/empty/error states, interaction, mobile, visual consistency, trust and product feel. Record and route observations for approval. Leave optimization and redesign to separately scoped work.

Report meaningful passes, findings, blockers, mutations, decisions and scope changes as they happen. End with the executive result, P0/P1, P2/P3, scoped acceptance outcomes, relevant state/provider, privacy and quality evidence, open coverage and exact next actions. Keep the evidence concise. Use subagents only for genuinely independent work with a clear coverage or context benefit. Keep stateful browser journeys with one agent by default. Claude normally owns hosted/adversarial testing, reconciliation and audit planning. Route source-level remediation, focused tests and CI/PR packaging to Codex unless implementation was explicitly assigned.
