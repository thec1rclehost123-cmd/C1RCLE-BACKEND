# Bounded bug remediation

Use Codex for implementation of an existing harness finding. Follow root `AGENTS.md` worktree, test and authority rules; this sequence adds finding-specific steps, not another copy of repository policy.

1. Load the permanent finding from `FINDINGS.json`, linked acceptance evidence from `ACCEPTANCE_STATE.json`, and relevant `CHANGE_IMPACT.json` area. Treat hosted evidence as reproduction evidence, not proof of current deployment behavior. Identify the expected boundary, affected consumers, preserved PASS evidence and required retest.
2. Confirm the exact approved repository/ref and clean isolated worktree. Reproduce with the smallest focused check when practical. Inspect targeted source and tests only; use targeted search, not CRG. Trace enough of the real execution path to identify the responsible boundary/root cause, then stop exploring.
3. Add a focused regression check that captures the finding. Make the smallest coherent change at the responsible boundary. During iteration, run the narrowest relevant checks and report the root cause, implementation boundary and focused result.
4. Prepare a concise RETEST PLAN from Change Impact: affected behavior and direct boundaries, at-risk and preserved acceptance, fixture needs, local checks, CI gate and deployed browser/provider/cross-role re-acceptance. Run the required final gate once on the intended diff, plus exact paired contract parity when applicable. Do not repeat comprehensive checks without a policy or risk reason.
5. Review the final diff, prepare the authorized PR package and record exact heads. Do not merge or deploy without authorization. Leave the finding open pending deployed targeted re-acceptance; update harness records only as authorized.

Do not absorb unrelated findings into the fix. Report a separate follow-up when adjacent debt does not block this finding.

## Result

`FINDING`; `ROOT CAUSE`; `FILES/BOUNDARY CHANGED`; `FOCUSED CHECKS`; `FINAL GATE`; `PR`; `HOSTED REACCEPTANCE REQUIRED`.
