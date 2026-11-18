# Milestone implementation

Use Codex to implement an explicitly approved Guest, Partner, Promoter, Scanner or Admin milestone without scope drift. Follow root `AGENTS.md` for worktree, verification and authority rules.

1. Read the approved milestone specification first. Use `C1RCLE_CONTEXT.md` for stable product/architecture context; inspect only relevant acceptance items and findings, and identify affected areas in `CHANGE_IMPACT.json`. Load fixture records only if the plan requires staging. Do not infer revision-specific acceptance from the context map.
2. Establish the exact approved baseline and any paired frontend/backend heads. Create a clean isolated worktree as root guidance requires. If the baseline cannot be established, report the ambiguity and withhold revision-specific claims.
3. Turn the milestone specification into a bounded implementation checklist and retest plan. Preserve the approved milestone boundaries; do not invent sub-milestones or pull in unrelated findings. Trace affected consumers and contracts before editing.
4. Implement in reviewable increments. Run focused tests while editing and preserve unrelated PASS evidence. For backend-owned wire contracts, establish exact paired-head parity. For shared changes, trace actual consumer paths and use Change Impact rather than retesting every product by default.
5. Run the required comprehensive final gate once on the final intended milestone diff, plus contract parity where applicable. Review the diff and package PR(s) with exact heads, CI state and clear separation. Stop before merge or deployment unless authorized.
6. Report hosted acceptance required after deployment, including which acceptance items and actor journeys remain. Update harness evidence only when authorized and only for checks actually run.

## Result

`MILESTONE`; `IMPLEMENTATION STATUS`; `CHANGE AREAS`; `TESTS`; `FINAL GATE`; `PRS`; `ACCEPTANCE REQUIRED`.
