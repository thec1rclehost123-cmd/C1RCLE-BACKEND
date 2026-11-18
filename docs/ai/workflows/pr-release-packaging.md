# PR / release packaging

Use Codex after implementation is complete to prepare a clean, reviewable delivery. This workflow packages existing work; it does not reopen product scope or authorize release actions.

1. Verify the intended branch/worktree, exact baseline and head, and inspect the full intended diff. Confirm only task-related files are included; preserve uncommitted work and do not stage the repository wholesale.
2. Check that required focused tests and final gates are valid for this exact diff. Run missing required gates once. Verify exact paired contract parity when applicable. If a gate fails, report it; fix only an in-scope packaging or implementation issue, otherwise stop for the owner.
3. Run appropriate secret/security checks and `git diff --check`. Review generated files, dependency/lockfile changes and ignored or untracked artifacts. Do not include credentials, private data, temporary worktree paths or unrelated debt.
4. Create clear, separable commits when that improves review. Prepare the PR with concise scope, implementation summary, verification, exact heads, CI status, known limitations and required deployed acceptance. Do not claim CI or deployment status without checking it.
5. Record the PR reference and exact source heads in the task report. Stop before merge, staging deployment or production release unless that action was explicitly authorized. Do not begin new bug fixing for unrelated findings discovered during review; report those separately.
6. Add changelog or release metadata only when the task and repository convention require it; do not invent release scope to make the package appear broader.

## Result

`DELIVERY`; `BASELINE/HEADS`; `DIFF SCOPE`; `CHECKS`; `CONTRACT PARITY`; `SECURITY/SECRET CHECK`; `COMMITS`; `PR`; `CI`; `ACCEPTANCE REQUIRED`; `NEXT ACTION`.
