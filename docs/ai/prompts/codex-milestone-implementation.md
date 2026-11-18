# Codex — Milestone Implementation

### TASK

Implement the explicitly approved milestone **[MILESTONE]**.

### USE

Use [`milestone-implementation`](../workflows/milestone-implementation.md).

### OWNER MUST PROVIDE

Fill the approved milestone/specification, baseline, repository constraints, delivery boundary and any non-canonical owner decisions below.

### AGENT MUST RETRIEVE

Read the cited specification and relevant context, findings, acceptance and Change Impact records through the workflow.

### SCOPE

- Specification: **[exact document/path or task reference]**
- Repositories: **[if constrained]**
- Do not invent additional milestones.

### BASELINE / ENVIRONMENT

- Approved branch/ref/head(s): **[exact baseline, or establish from active task/worktree/PR context and stop if unresolved]**
- Paired heads, if applicable: **[exact heads or establish from the approved task context]**

### AUTHORIZED

- Implementation and delivery boundary: **[PR only / merge authorized / other]**
- Merge: **[YES/NO]**. Staging deploy: **[YES/NO]**. Production deploy: **[YES/NO]**.

### NOT AUTHORIZED

- **[task-specific prohibited actions]**

### OWNER DECISIONS / CONSTRAINTS

- **[only decisions not already canonical, or “none”]**

### DELIVERY / STOP

**[completion criteria and exact stop boundary]**

Flag conflicts with the current harness/source. Do not infer product-policy overrides; pause affected work and ask the owner when a decision is needed.

### EXAMPLE ONLY — NOT AUTHORIZATION

**TASK:** Implement the owner-approved Partner M3 milestone. **SPECIFICATION:** exact approved spec must be supplied before implementation. **BASELINE:** establish paired heads from the active task/PR context; stop if unresolved. **REPOSITORIES:** backend and frontend only if the approved spec requires both. **DELIVERY:** PR preparation only. **MERGE/DEPLOY:** NO. **OWNER DECISIONS:** None supplied; surface any required product decision. **STOP:** do not add milestones beyond the cited specification.
