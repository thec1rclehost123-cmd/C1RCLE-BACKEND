# C1RCLE task prompts

One owner-to-agent prompt library for Claude and Codex. Copy one template, fill its owner inputs, and give it to the named agent. These are task contracts, not launchers; they do not start agents or grant authorization by themselves.

## Templates

| Agent | Template | Canonical workflow |
| --- | --- | --- |
| Claude | [Comprehensive hosted audit](claude-comprehensive-hosted-audit.md) | [hosted-audit](../workflows/hosted-audit.md) |
| Claude | [Targeted re-acceptance](claude-targeted-reacceptance.md) | [targeted-reacceptance](../workflows/targeted-reacceptance.md) |
| Claude | [Cross-role / cross-system acceptance](claude-cross-role-acceptance.md) | [cross-role-acceptance](../workflows/cross-role-acceptance.md) |
| Codex | [Bounded bug remediation](codex-bounded-bug-remediation.md) | [bounded-remediation](../workflows/bounded-remediation.md) |
| Codex | [Milestone implementation](codex-milestone-implementation.md) | [milestone-implementation](../workflows/milestone-implementation.md) |
| Codex | [Delivery / merge / deploy verification](codex-delivery-verification.md) | [pr-release-packaging](../workflows/pr-release-packaging.md) |

## How to fill them

**OWNER MUST PROVIDE** the task, scope, approvals, and delivery/stop boundary requested by the selected template. Supply an exact approved baseline when known; otherwise explicitly ask the agent to establish it from the active checkout/worktree or PR context and stop revision-specific claims if it cannot. For hosted work, name the intended environment and provide deployed revisions when known; the agent establishes unknown deployed provenance using the Step 10 helper.

**AGENT MUST RETRIEVE** architecture and policy from `C1RCLE_CONTEXT.md`, task records from Acceptance State / Findings / Fixtures / Change Impact, and execution details from the named workflow. Hosted preparation uses `pnpm acceptance:prepare`; long audits use `pnpm acceptance:checkpoint` at meaningful boundaries. Do not paste those records into the prompt unless an owner decision specifically overrides or clarifies them.

Enter task-specific authorized actions and stop boundaries explicitly. An example is not authorization. Keep credentials out of prompts; use fixture/helper credential labels. If supplied facts conflict with current harness or source, flag the conflict; only a clear current owner instruction overrides prior product policy. These prompts do not authorize merges, deployments, production work or provider actions unless the corresponding owner input explicitly does so.

## Prompt-material disposition

The historical [`V2 Backend Engineering — Senior Developer / IT Team Master Prompt`](../../reference/V2%20Backend%20Engineering%20%E2%80%94%20Senior%20Developer%20-%20IT%20Team%20Master%20Prompt.md) remains archived and unchanged. It predates the current repositories and harness, so it is superseded as a task prompt. Use one of the six templates above for new work; retrieve current policy from the harness.

## Dry reasoning checks

These checks use the current harness records only; none of the example tasks was executed.

| Scenario | Result | Why |
| --- | --- | --- |
| A — `PARTNER-SLOT-001` remediation | **SUFFICIENT** | The template requires the finding ID, approved baseline or an instruction to establish it from task/PR context, delivery boundary and separate merge/deploy approvals. Codex retrieves `partner.venue.slot-decision`, `partner.slot-lifecycle`, linked fixtures and remediation constraints. |
| B — `GUEST-RSVP-001` deployed fix | **SUFFICIENT** | The template needs the finding, deployed revisions when known, environment and authorized actions. Claude retrieves `guest.rsvp`, `guest.rsvp` Change Impact, `guest_fresh_rsvp_lifecycle`, and applicable PASS evidence through the workflow. |
| C — Guest comprehensive audit | **SUFFICIENT** | The template supplies target, scope, environment, revision-provenance instruction, actions and stop boundary. Claude retrieves browser-first coverage, evidence reuse, fixture selection, checkpointing and reporting from the guide/workflow/helpers. |
| D — Host → Venue → Guest publication | **SUFFICIENT** | The template names the scenario, actors, starting fixture/requirement and mutation/provider/stop boundaries, and explicitly carries the same business object through every role. The workflow supplies state reconciliation and role transitions. |

Typical filled prompt estimates (excluding linked specifications): targeted re-acceptance **145–195 words**; bounded remediation **180–250 words**; milestone implementation **170–280 words**; comprehensive hosted audit **250–400 words**.
