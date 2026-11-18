# Codex — Bounded Bug Remediation

### TASK

Remediate **[FINDING IDS]** within the approved scope.

### USE

Use [`bounded-remediation`](../workflows/bounded-remediation.md); retrieve finding detail, linked acceptance, Change Impact and relevant fixtures as needed.

### OWNER MUST PROVIDE

Fill finding IDs, approved baseline or establishment instruction, delivery boundary, merge/deploy approvals and special constraints below.

### AGENT MUST RETRIEVE

Load finding detail, linked acceptance, Change Impact and relevant fixtures from the harness.

### SCOPE

- Finding IDs: **[one or a small related set]**
- Repositories: **[if constrained]**
- Delivery: **[for example, prepare paired frontend/backend PRs]**

### BASELINE / ENVIRONMENT

- Approved branch/ref/head(s): **[exact baseline, or establish from the active task/worktree/PR context and stop if unresolved]**
- Hosted target, if relevant: **[environment and deployed revisions or establish separately]**

### AUTHORIZED

- **[implementation and delivery actions allowed]**
- Merge: **[YES/NO]**. Deploy to staging: **[YES/NO]**. Deploy to production: **[YES/NO]**.

### NOT AUTHORIZED

- **[task-specific prohibited actions]**

### OWNER DECISIONS / CONSTRAINTS

- **[only constraints not already in the harness, or “none”]**

### DELIVERY / STOP

**[PR, merge, deploy or verification boundary; state where to stop]**

Flag conflicts with the current harness/source. Do not infer product-policy overrides; pause affected work and ask the owner when a decision is needed.

### EXAMPLE ONLY — NOT AUTHORIZATION

**TASK:** Investigate and fix `PARTNER-SLOT-001`. **BASELINE:** establish the approved paired heads from active PR/worktree context; stop if unresolved. **DELIVERY:** prepare scoped PR(s). **AUTHORIZED:** code changes and focused validation only. **MERGE:** NO. **STAGING DEPLOY:** NO. **PRODUCTION:** NO. **STOP:** report PR/head and hosted re-acceptance still required.
