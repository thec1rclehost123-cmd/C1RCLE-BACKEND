# Code Review Graph evaluation

**Decision — REJECT for routine C1RCLE use.** Code Review Graph (CRG) produced useful caller and import links for current pricing and Venue availability, but it did not reduce the verified source reading needed for those paths. The compact graph runs found 24 of 35 source anchors, compared with 35 of 35 for targeted search. The slot, Razorpay and shared-contract cases needed source search to recover important boundaries. This is a decision about the measured C1RCLE workflow and version.

## Version and isolation

Evaluated the published `code-review-graph==2.4.0` wheel and inspected upstream tag `v2.4.0` at `b3f1285965a1337b3821e4423da03b65d70ee423`. The repositories were clean temporary Git snapshots of the committed staging sources. Frontend used `8532a73cfee9512ac38f2617ed61b50f4da20e90`, and backend used `3802889f929e933b5312e9b3c17b5e22aeb9be6d`. The frontend archive omitted 20 non-JS/TS paths via export attributes. All tracked JS/TS was present in the archive. The snapshots excluded local secrets, dependencies and uncommitted work. [Upstream release](https://github.com/tirth8205/code-review-graph/releases/tag/v2.4.0)

Upstream supports pip or pipx, a CLI and an MCP server. The SQLite graph lives in `.code-review-graph/graph.db` by default or an explicit external data directory. The Tree-sitter index and lexical search work locally. Local vector embeddings are optional, and cloud providers are separate opt-in modes. The temporary Python 3.12 environment used the base wheel and default graph postprocessing. Indexing and queries ran under an OS network deny with the real home inaccessible. The isolated Claude transport check allowed loopback for a local mock provider. Neither graph had embeddings. [Upstream usage](https://github.com/tirth8205/code-review-graph/blob/v2.4.0/docs/USAGE.md)

### Dry-run changes and rollback

The integration installer was previewed with `install --dry-run --yes --platform <platform>` against both snapshots and a temporary home. It reported no writes, and the Git snapshots and temporary client configuration remained unchanged after the dry runs.

| Target | Proposed changes |
| --- | --- |
| Claude on frontend | Replace the CRG entry in `.mcp.json`, revise four existing `.claude/skills/*/SKILL.md` files, update `.claude/settings.json`, create its `.bak`, and install four Git hooks. |
| Claude on backend | Replace the CRG entry in `.mcp.json`, add four skills and `.claude/settings.json`, update root `CLAUDE.md`, and install four Git hooks. |
| Codex on either snapshot | Add `$CODEX_HOME/config.toml` and `hooks.json`, add skill files `SKILL.md`, `agents/openai.yaml`, `scripts/crg_readonly.py` and `.code-review-graph-managed.json`, add root `AGENTS.md`, and install four Git hooks. |

The Git hooks were `pre-commit`, `post-checkout`, `post-merge` and `post-rewrite`. The graph directory was already ignored in both snapshots. The installer was never applied. Client probes used explicit temporary stdio configuration without hooks or instructions. Before/after signatures covered 29 real config and instruction paths, including user settings, repository MCP, skills and the locked harness. Upstream offers `uninstall --dry-run` and a scoped uninstall for its own changes. Deleting the isolated environment and snapshots was sufficient here. [Upstream install and uninstall](https://github.com/tirth8205/code-review-graph/blob/v2.4.0/README.md#quick-start)

## Index measurements

| Repository | First build | Indexed files | Graph database | JS/TS file coverage |
| --- | ---: | ---: | ---: | --- |
| Frontend | 29.34 s | 1,497 | about 130 MiB | 1,405 of 1,408, with three generated `next-env.d.ts` files intentionally excluded |
| Backend | 56.15 s | 839 | about 189 MiB | 748 of 748 |

The first frontend build exited successfully but printed five five-second grammar-probe timeouts, including TypeScript and JavaScript. File counts alone would have hidden degraded coverage. A fresh frontend database rebuilt without those warnings in 28.60 s and gained 218 nodes and 218 reported edges at the same file count. The navigation comparison below used this warning-free frontend graph. Backend built without parser warnings. Both used the standard file-based community fallback because optional igraph was absent. Every major app/package in the benchmark scope had indexed files. No indexed file was under a `node_modules`, `.next`, `dist`, `build` or `vendor` directory. Build/vendor trees were absent in the clean snapshots, and CRG explicitly logged the generated Next output exclusions.

## Navigation comparison

Each case used a scoped search plan with known C1RCLE symbols and a checked set of relevant source files covering the expected boundaries. Search used scoped ripgrep file matches. The first RSVP search needed a Wallet follow-up, which informed the search used in the final replay. CRG used persistent stdio sessions with per-repository minimal context followed by compact callers, callees, importers, tests or lexical search. The two methods opened returned files from the same anchor set. Extra candidates are off-rubric results and may include useful adjacent tests. Times measure retrieval and anchor reads, excluding discovery of the query plan, client startup, model reasoning and graph builds. This is a known-symbol comparison on one machine.

In the table, **ops** includes minimal-context calls, **opened** counts anchor files actually read, and **extra** counts distinct off-rubric files surfaced. Fewer opened files with missed anchors are incomplete coverage.

| Question | Search ops / opened / extra / seconds | CRG ops / opened / extra / seconds | CRG anchor recall | Overall |
| --- | --- | --- | --- | --- |
| A. Free RSVP and Wallet | 2 / 6 / 11 / 0.035 | 8 / 4 / 6 / 3.442 | 4/6 | MIXED |
| B. Current price and Guest consumers | 2 / 6 / 8 / 0.038 | 8 / 6 / 7 / 1.975 | 6/6 | MIXED |
| C. Venue availability to Host editor | 2 / 5 / 5 / 0.025 | 8 / 5 / 7 / 1.361 | 5/5 | MIXED |
| D. Slot Accept/Decline and persistence | 2 / 6 / 3 / 0.029 | 8 / 3 / 5 / 1.973 | 3/6 | POOR |
| E. Razorpay confirmation and fulfillment | 1 / 5 / 4 / 0.018 | 5 / 2 / 3 / 1.591 | 2/5 | POOR |
| F. RSVP response contract blast radius | 2 / 7 / 5 / 0.022 | 8 / 4 / 2 / 3.494 | 4/7 | POOR |

| Case | Precision | Recall | Noise | Speed | Source-reading reduction | Trustworthiness |
| --- | --- | --- | --- | --- | --- | --- |
| A | MIXED | MIXED | GOOD | POOR | POOR | MIXED |
| B | MIXED | EXCELLENT | MIXED | POOR | POOR | GOOD |
| C | MIXED | EXCELLENT | MIXED | POOR | POOR | GOOD |
| D | MIXED | POOR | POOR | POOR | POOR | POOR |
| E | MIXED | POOR | MIXED | POOR | POOR | POOR |
| F | GOOD | MIXED | GOOD | POOR | POOR | POOR |

### What the graph actually linked

- **A — RSVP.** Compact retrieval found the Guest confirmation component, BFF, Core checkout service and backend Wallet route. It missed the RSVP Gateway route and Guest Wallet mapping. An expanded `createRsvp` caller query recovered the Gateway route with about 38.8 KB of output. Exact lexical lookup recovered the Wallet mapper. The URL handoff still needed source confirmation across repositories.
- **B — price and CTA.** Caller queries surfaced the shared current-price calculator, public discovery and frontend mapping consumers. `toExploreEvent` and `toEventDetailFixture` returned direct callers. The graph helped order the reads, and search found the same anchors with fewer operations.
- **C — availability.** The graph followed `loadHostAvailability` into `useHostAvailability` and Host editor consumers, including a reverse import through the app alias. The backend availability call also led to the Gateway handler. Eleven of 15 backend availability callee results were unresolved, so the underlying access and repository behavior still needed source verification.
- **D — slot decisions.** `callers_of(acceptSlotRequest)` returned zero for a real action dispatched through an object map. `references_to` correctly found the map. A broader qualified backend `accept` query recovered the Gateway route as unresolved. The compact pass missed both Firestore adapters.
- **E — Razorpay.** Compact queries missed the callback and webhook routes and the entitlement adapter. Wider confirmation caller results recovered the webhook as an unresolved target. A separate qualified callback query recovered the payment route as another unresolved target. `completeFulfilment` needed qualification to resolve the method and still reported 21 unresolved call sites out of 41. The composition root and repository ports were necessary to trace concrete writes.
- **F — contract.** The graph found both mirrored schema files and the main producer/consumer. Its compact run missed the frontend RSVP test through `CheckoutView`, the backend scenario and the exporter. A zero direct-test result on the inner checkout component did not establish missing coverage. The two independent graphs did not establish export/parity linkage. The relevant contract is generated TypeScript/Zod rather than TypeSpec.

The dynamic import from Guest `UserTicketsView` to `TicketDetailModal` appeared in `imports_of`. A Next filesystem RSVP route query was ambiguous, while the equivalent Fastify endpoint query returned no match even though the handler and registration existed. The broader Fastify registry query recovered both payment route registrations with about 66 KB of output. These are concrete successes and limitations of this run, rather than assumptions about every TypeScript pattern.

## Incremental maintenance and client integration

Added, renamed the exported function in, then removed one temporary TypeScript file in each snapshot. Each update reported one changed file, no existing File-node timestamps changed, and the old symbol disappeared after edit. File counts returned to baseline and the replacement symbol disappeared after removal.

| Repository | Add | Edit | Remove | No-op |
| --- | ---: | ---: | ---: | ---: |
| Frontend | 7.20 s | 3.26 s | 2.93 s | 1.24 s |
| Backend | 12.50 s | 4.45 s | 3.07 s | 0.60 s |

The elapsed updates include process startup and default postprocessing. The test supports one-file reparsing and correct graph refresh. It does not establish how cheap broad refactors or long-lived maintenance would be.

- **Claude Code 2.1.74** — Temporary native stdio registration connected. With a local mock model endpoint, Claude advertised the tools, executed one selected `query_graph_tool` and delivered its result. In separate runs the same local client completed with the server absent and with a failing server. This verified client plumbing and fallback, with no live model judgment measured.
- **Codex CLI 0.169.0-alpha.11.1** — An offline app-server thread discovered the 30 MCP tools from the temporary config and called one named backend query, which returned 11 confirmation call sites. The upstream integration also offers a read-only CLI skill fallback. The skill was inspected and left uninstalled. This verified selective tool access without a live model turn.

The full MCP tool inventory was 46,548 bytes serialized. This is an upper proxy for exposed tool-description payload, since client filtering and deferred loading can change what reaches the model. Compact graph responses across six cases were about 49.8 KB versus 4.3 KB of search candidate paths. The payloads contain different information, so bytes are a context proxy. No model token savings or hosted response quality were measured.

## Activation and retest scope

Keep targeted search as the default. Re-evaluate CRG only for an owner-approved investigation with unclear multi-package caller or blast-radius boundaries, and verify its leads in source. Skip it for known files, isolated UI and test fixes, documentation and harness updates. CRG can supply structural leads where calls and imports resolve. `CHANGE_IMPACT.json` still owns product retest scope, fixtures and evidence reuse. A graph result cannot establish authorization, provider behavior or acceptance.

No application tests, builds, CI jobs, payments or staging actions were run. No permanent integration or locked harness edits were made.
