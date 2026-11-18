# Claude — Cross-role / Cross-system Acceptance

### TASK

Accept **[SCENARIO]** across the specified C1RCLE roles.

### USE

Use [`cross-role-acceptance`](../workflows/cross-role-acceptance.md).

### OWNER MUST PROVIDE

Fill the scenario, actor constraints, starting fixture/requirement, authorized mutations, provider authorization and stop boundary below.

### AGENT MUST RETRIEVE

Use the workflow and current harness for fixture readiness, allowed transitions and reconciliation details.

### SCOPE

- Scenario and actors: **[journey and any actor restrictions]**
- Starting fixture/requirement: **[catalog ID, or ask the agent to select from the harness]**
- Follow the **same business object** throughout every role and surface.

### BASELINE / ENVIRONMENT

- Environment and deployed revisions: **[environment; exact revisions or establish with Step 10]**

### AUTHORIZED

- Mutations and role/account transitions: **[explicit list]**
- Provider authorization: **[none or exact authorized action]**

### NOT AUTHORIZED

- **[task-specific prohibited actions]**

### OWNER DECISIONS / CONSTRAINTS

- **[special fixture or handoff boundary, or “none”]**

### DELIVERY / STOP

Report each transition and state reconciliation. Stop at **[boundary]**.

Keep progress updates concise and surface meaningful findings or blockers immediately.

Flag conflicts with the current harness/source. Do not infer product-policy overrides; pause affected work and ask the owner when a decision is needed.

### EXAMPLE ONLY — NOT AUTHORIZATION

**TASK:** Verify Host → Venue → Guest publication. **ACTORS:** Host A, Venue A, Guest. **START:** `publication_journey`; verify whether its requirement has been provisioned and bound before use. **BASELINE:** staging; establish deployed revisions. **AUTHORIZED:** Submit and accept a fresh request, then inspect the same event as Guest, only after owner approval. **PROVIDER:** None. **STOP:** If the requirement is unbound, stop and report it; otherwise report the same event identity and each state transition.
