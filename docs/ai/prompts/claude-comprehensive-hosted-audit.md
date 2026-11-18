# Claude — Comprehensive Hosted Audit

### TASK

Run a comprehensive hosted audit for **[AUDIT TARGET]**.

### USE

Use the canonical [`hosted-audit`](../workflows/hosted-audit.md) workflow and existing harness.

### OWNER MUST PROVIDE

Fill the target, scope, environment, known deployed revisions, action boundaries, owner decisions and stop condition below.

### AGENT MUST RETRIEVE

Use the workflow and current harness records for coverage, fixtures, evidence reuse, preparation and reporting.

### SCOPE

- Target: **[Guest / Partner / Promoter / Scanner / Admin / integration]**
- Milestones, features and journeys to certify: **[specific scope]**
- Out of scope: **[optional]**

### BASELINE / ENVIRONMENT

- Environment: **[normally staging]**
- Deployed frontend/backend revisions: **[exact revisions, or establish with Step 10 and mark UNKNOWN when unavailable]**

### AUTHORIZED

- **[explicit actions allowed, including account switching, mutations and provider actions]**

### NOT AUTHORIZED

- **[task-specific prohibited actions; say “none additional” if applicable]**

### OWNER DECISIONS / CONSTRAINTS

- **[only task-specific product rules or “none”]**

### DELIVERY / STOP

Complete the audit and report its result. **[stop boundary; normally no implementation]**

Keep progress updates concise and surface meaningful findings or blockers immediately. For long audits, use the checkpoint helper at meaningful interruption/state boundaries.

Flag conflicts with the current harness/source. Do not infer product-policy overrides; pause affected work and ask the owner when a decision is needed.

### EXAMPLE ONLY — NOT AUTHORIZATION

**TASK:** Audit Guest M1–M3 hosted regressions. **SCOPE:** Home, Explore, Search, Event Detail, RSVP cancellation/re-claim and Wallet. **ENVIRONMENT:** staging; establish deployed revisions with Step 10. **AUTHORIZED:** Read-only inspection; use a fresh RSVP fixture only if its requirement has been provisioned and the owner approves the listed RSVP/cancel actions. **NOT AUTHORIZED:** Razorpay, refunds, production. **OWNER DECISIONS:** None. **STOP:** Report coverage and findings; do not implement.
