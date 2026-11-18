# Session checkpoints

Checkpoints are short-lived operational continuity for an in-progress task. Acceptance truth stays in `ACCEPTANCE_STATE.json`, finding detail in `FINDINGS.json`, and fixture readiness in `STAGING_FIXTURES.json`. Local checkpoint files are ignored by Git at `docs/ai/checkpoints/local/`.

Create after setup or at a meaningful boundary:

```sh
pnpm acceptance:checkpoint -- create --workflow hosted-audit --task "Guest M1-M3 hosted audit" --environment staging --role "Guest=Guest Complete" --credential-ref C1RCLE_QA_GUEST_COMPLETE --fixture guest_canonical_paid_event --session-state SESSION_MUST_BE_RECREATED --browser-position "Explore loaded; no mutation" --next-action "Verify current deployment and Guest authentication, then open the event detail."
```

Use `list`, `show <id>`, `validate <id>`, `resume <id> [--json]`, `export <id>`, `set <id> <field> <value>`, and `record <id> <kind> ...`. For example, `record <id> object --type order --object-id order_123`; `record mutation` stores the exact object/action/outcome and reversibility/reset state. `wait-owner` and `owner-done` update provider handoff without starting another provider action. Use `complete` or `abandon` when the checkpoint is no longer resumable.

The helper rejects unknown/secret-like fields and values. It stores labels only, never browser cookies or login state. Resume output is a prompt packet, not an automatic login or replay: always recheck authentication, exact object state and provider handoff. Re-run Step 10 with `pnpm acceptance:prepare -- prepare <surface> --json` and `pnpm acceptance:prepare -- fixture <id>` for fresh environment and fixture verification; compare deployed revisions and consult Change Impact if they differ. Never repeat a payment merely because a session was interrupted. `export <id>` emits the validated, schema-limited JSON record for manual transfer; inspect it before sharing and never append credentials or session data.

Checkpoint at environment setup, after state mutations, after major sections, before owner/provider handoff, and before ending a session. Do not update it after every click. Keep each record below 800 words and close completed work with `complete`.
