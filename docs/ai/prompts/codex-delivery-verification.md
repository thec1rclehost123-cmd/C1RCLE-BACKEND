# Codex — Delivery / Merge / Deploy Verification

### TASK

Package or verify already implemented work for **[DELIVERY TARGET]**.

### USE

Use [`pr-release-packaging`](../workflows/pr-release-packaging.md). If deployed browser acceptance is included, use or hand off to the matching Claude acceptance workflow.

### OWNER MUST PROVIDE

Fill PRs/heads, merge order, separate merge/staging/production approvals, post-deploy checks and exact stop boundary below.

### AGENT MUST RETRIEVE

Use the workflow for packaging/release checks and the relevant acceptance/finding records for named post-deploy verification.

### SCOPE

- PRs and exact source heads: **[links/IDs and heads]**
- Expected merge order: **[if relevant]**
- Post-deploy acceptance/findings: **[IDs or “none”]**

### BASELINE / ENVIRONMENT

- Approved baseline and intended target environment: **[exact refs and staging/production target]**

### AUTHORIZED

- Merge: **[YES/NO; exact PRs/order]**
- Staging deploy: **[YES/NO; exact target]**
- Production deploy: **[YES/NO; exact target; normally NO]**
- Post-merge/deploy checks: **[specific checks and acceptance scope]**

### NOT AUTHORIZED

- **[task-specific prohibited actions]**

### OWNER DECISIONS / CONSTRAINTS

- **[approval or stop boundaries, or “none”]**

### DELIVERY / STOP

Stop after **[prepare PR / merge named PRs / staging verification / other exact boundary]**.

Flag conflicts with the current harness/source. Do not infer product-policy overrides; pause affected work and ask the owner when a decision is needed.

### EXAMPLE ONLY — NOT AUTHORIZATION

**TASK:** Package two completed paired PRs and verify their staging deployment. **PRS/HEADS:** supply exact links and heads. **ORDER:** backend, then frontend if both are approved and compatible. **MERGE:** NO until exact approval. **STAGING:** NO until exact approval. **PRODUCTION:** NO. **POST-DEPLOY:** if authorized later, hand off targeted browser checks for the named findings. **STOP:** prepare package and report required approvals; do not merge or deploy.
