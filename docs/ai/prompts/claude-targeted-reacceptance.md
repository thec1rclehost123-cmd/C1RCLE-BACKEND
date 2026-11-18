# Claude — Targeted Re-acceptance

### TASK

Verify the deployed fix for **[FINDING IDS]**.

### USE

Use [`targeted-reacceptance`](../workflows/targeted-reacceptance.md).

### OWNER MUST PROVIDE

Fill finding IDs, environment, known deployed revisions, authorized actions and any special fixture/human boundary below.

### AGENT MUST RETRIEVE

Derive linked acceptance, Change Impact, fixture readiness and preserved PASS evidence from the harness.

### SCOPE

- Finding IDs: **[one or a small related set]**
- Environment: **[staging or specified environment]**
- Deployed fix revisions: **[exact revisions or establish with Step 10]**

### AUTHORIZED

- **[specific hosted actions allowed]**

### NOT AUTHORIZED

- **[task-specific prohibited actions]**

### OWNER DECISIONS / CONSTRAINTS

- **[special fixture or human boundary, or “none”]**

### DELIVERY / STOP

Report targeted outcome and remaining closure conditions. **[stop boundary]**

Surface meaningful findings/blockers promptly; checkpoint only if useful.

Flag conflicts with the current harness/source. Do not infer product-policy overrides; pause affected work and ask the owner when a decision is needed.

### EXAMPLE ONLY — NOT AUTHORIZATION

**TASK:** Re-accept `GUEST-RSVP-001`. **SCOPE:** staging; establish deployed fix revisions. **AUTHORIZED:** RSVP → cancel → re-RSVP on the verified fresh lifecycle fixture after separate provisioning and approval. **NOT AUTHORIZED:** payment or production actions. **OWNER DECISIONS:** Stop if the required fixture remains unbound. **STOP:** Report targeted result; do not broaden to a Guest audit.
