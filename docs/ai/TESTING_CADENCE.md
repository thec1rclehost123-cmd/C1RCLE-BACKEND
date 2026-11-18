# C1RCLE Testing & Audit Cadence

This policy decides **how far to test**. `CHANGE_IMPACT.json` identifies affected behavior, consumers, evidence and fixtures; this cadence chooses validation depth. Workflows define execution; `ACCEPTANCE_STATE.json` stores evidence.

Within hosted levels, retain the applicable API/runtime, browser, provider and actor scopes from Change Impact; those scopes can stack.

## Testing levels

Add higher-level evidence only where needed; keep applicable local/CI gates. Broader hosted levels do not imply Level 6.

| Level | Name | When to use |
| --- | --- | --- |
| 0 | No product retest | Documentation, harness-only or non-runtime metadata with no product behavior impact. Run relevant formatting, schema, link or helper validation. |
| 1 | Focused local validation | During implementation: the smallest relevant unit, component, service, typecheck, lint or emulator check. This is the normal Codex iteration level. |
| 2 | Final PR / CI gate | Once on the intended final diff: repository-required formatting, lint, typecheck, tests, build, parity and security checks. Follow repository policy. This is deterministic evidence, not hosted acceptance. |
| 3 | Targeted hosted re-acceptance | After a deployed bounded behavioral change: exercise the changed behavior and directly affected boundaries in the real product; reconcile relevant state. Default hosted level for a normal behavioral fix. |
| 4 | Milestone / feature acceptance | After a meaningful feature group is deployed: cover its main workflows, important edge states and directly connected existing capabilities for affected roles. Broader than one finding, narrower than a monster audit. |
| 5 | Cross-role / cross-system acceptance | When the behavior inherently crosses actors, product surfaces or an integrated state transition. Follow and reconcile the same business object throughout. Add a provider only when required and authorized. |
| 6 | Comprehensive hosted / monster audit | An explicitly approved broad adversarial audit at a major gate, for accumulated integration risk, or when targeted evidence cannot bound a broad change. Expensive; not the default after a bug or milestone. |
| 7 | Final launch certification | The highest gate against the exact intended Release Candidate and configuration. It deliberately assembles the launch evidence package; Step 14 defines its artifact. |

CI green is not product acceptance, and hosted PASS does not replace applicable deterministic security, contract or build gates.

## Local implementation and final gates

During active implementation, run the smallest relevant checks while editing (Level 1). Batch related changes. Do not repeatedly run full monorepo suites, builds, lint or CI-equivalent validation after each correction.

On the intended final diff, run the required repository gate once (Level 2), including applicable parity and security checks. Batch routine formatting/import/lint fixes, then rerun the failed or relevant gate where policy allows. Repeat the entire gate only when change, risk or policy requires it. Record hosted evidence against the exact deployed revisions and journeys exercised.

## Default cadence by work type

### Bounded behavioral bugs

Normal sequence: **Level 1 during implementation → Level 2 on the final diff → merge/deploy when authorized → Level 3** on the deployed fix. A finding closes only when its documented closure rule is met, including the required deployed provenance and successful targeted re-acceptance for hosted defects. Do not run Level 6 merely because a bug was found.

For security and authorization defects—such as IDOR, cross-organization access, session/auth, financial privacy, QR eligibility, KYC gates or admin permissions—Level 3 must exercise both an allowed actor and a denied actor. Use Level 5 when the authorization boundary spans roles or systems. Escalate to Level 6 only when shared security architecture changed broadly, blast radius remains genuinely uncertain, or targeted checks cannot establish the affected boundary.

### Payments

Choose provider scope from the changed boundary:

- **Presentation-only:** Levels 1 and 2; add a representative Level 3 browser check if deployed behavior changed. No provider payment by default.
- **Quote, fee or tax calculation:** Level 3 must reconcile canonical pricing and conservation where applicable.
- **Hold or inventory:** Level 3 must compare before/after inventory and persisted state.
- **Razorpay initiation, verification or webhook:** Level 3 with provider participation when the changed behavior requires it, explicitly authorized, on approved disposable Test Mode state.
- **Shared fulfillment or idempotency:** use Level 5 when the affected journey spans provider → order → inventory → ticket → Wallet.

An unrelated Guest UI change does not authorize or require a new Razorpay payment. Provider actions are costly and stateful evidence; use them only when the changed behavior, approved milestone or deliberate audit requires that boundary.

### Partner availability and slot lifecycle

An availability-only change may need Level 3 when only Host calendar visibility or selection changed. A slot request decision normally needs Level 5: Host submits → Venue sees and decides → persisted request/slot state → Host sees the result. If publication behavior changes, continue the same event through Guest. Do not substitute disconnected example requests for same-object reconciliation. Keep Accept and Decline on separate approved fixtures where the catalog requires it.

### Milestones and Experience Quality

For each approved milestone, use **Level 1 during implementation → Level 2 on the final diff → staging → normally Level 4**. Use Level 5 when the milestone inherently crosses roles or systems. Do not automatically use Level 6 after each milestone. After a milestone group, broaden only when Change Impact or accumulated risk justifies it.

For Experience Quality implementation, use Level 1 focused component/visual/browser checks and Level 2 final deterministic validation. After deployment, use representative Level 3 or Level 4 browser acceptance according to scope. Cover affected desktop and mobile states, loading/empty/error states and interactions. Do not rerun payments or unrelated business workflows for styling alone; escalate if interaction or state logic changed.

### Configuration and deployment

Changes to Vercel, Render, Firebase, Razorpay, Resend, environment variables, OAuth, webhooks, Firestore indexes or rules require runtime/deployed verification; code CI alone is insufficient. Use at least Level 3 against the affected runtime/provider boundary, with explicit authorization for provider or environment changes. Use Level 5 if the change affects a multi-role or cross-system journey. Merge, deploy and production release remain separate authorization boundaries.

## Evidence reuse and escalation

Reuse scoped PASS evidence unless implementation, contract/configuration, stronger contradictory evidence, expiry, fixture/environment applicability or an approved recertification gate invalidates reuse. Do not rerun PASS merely because it appears in a checklist; report why preserved evidence still applies.

Deliberately re-exercise critical behavior when Level 6 scope includes it, the final Release Candidate requires it, broad shared infrastructure changed, accumulated changes create meaningful integration uncertainty, prior evidence is stale/inapplicable, or the owner explicitly requests recertification. Evidence reuse saves effort; it does not excuse an approved final test.

Start at the lowest level justified by Change Impact and required gates. Escalate with a reason when actual fan-out grows, roles/provider/authorization boundaries change, state diverges, an unexpected regression appears, deployment/configuration differs, or related findings suggest systemic failure. Do not escalate merely because “more testing is safer.”

De-escalate broad hosted retests when behavioral impact is demonstrably narrow, Change Impact identifies actual consumers, deterministic gates establish unaffected boundaries, and prior hosted evidence remains applicable. A broad code diff alone does not require broad hosted testing.

Credible P0/P1 during acceptance—such as unauthorized access, money or inventory corruption, duplicate fulfillment, unsafe provider behavior or destructive data corruption—stops the risky continuation. Preserve evidence and mutations, then report the minimum safe next action. P2/P3 findings normally do not stop Level 6 breadth; capture them and continue where safe.

## Decision table

`L` = focused local (Level 1); `CI` = final deterministic gate (Level 2); `H` = hosted Level 3 or 4 as scoped; `X` = Level 5; `M` = Level 6 only at an approved gate; `RC` = Level 7.

| Change or event | L | CI | H | X | M / RC |
| --- | --- | --- | --- | --- | --- |
| Documentation, harness or non-runtime metadata | Relevant validation | If repository policy requires | — | — | — |
| Isolated copy/presentation change | L | CI | Representative H only if deployed behavior/interaction warrants it | — | — |
| Bounded RSVP behavioral fix | L | CI | H | If a cross-role boundary is affected | — |
| Auth / IDOR / permissions fix | L | Security CI | H: allowed and denied actor | If boundary spans roles/systems | M only for broad shared architecture or uncertain blast radius |
| Partner availability only | L | CI | H | If request/decision/publication handoff changes | — |
| Partner slot request decision | L | CI | H | X: same request Host → Venue → Host; extend to Guest if publication changes | — |
| Quote/fee calculation | L | CI | H: reconcile canonical total | If downstream purchase/fulfillment is changed | — |
| Razorpay initiation/verification/webhook | L | CI | H plus authorized provider evidence | If integrated order/inventory/ticket/Wallet state changes | — |
| Approved milestone after deployment | L | CI | H: Level 4 acceptance | When inherent to milestone | No automatic M |
| Provider/configuration change | L | CI | H against affected runtime/provider | If journey crosses actors/systems | — |
| EQ styling or interaction | L | CI | Representative H: Level 3/4 | Only if role/state boundary changes | — |
| Access/Promoter/Scanner integrated group | L | CI | H | X: same-object integrated journey | M at the planned Gate H |
| Exact intended Release Candidate | As required | Required | Deliberately re-exercise per plan | As required | RC: Level 7 |

## Quick decision rule

1. **No product runtime behavior impact?** Level 0; run relevant documentation/schema/helper validation. Apply Level 1/2 only when the changed artifact or repository policy needs them.
2. **Implementation changed?** Use Level 1 while editing and Level 2 once the intended diff is ready, as required by repository policy.
3. **Deployed behavior changed?** Use Level 3 for the bounded affected behavior; reuse unrelated PASS evidence.
4. **Meaningful feature group deployed?** Use Level 4. If its behavior inherently crosses roles/systems, use Level 5 for those transitions.
5. **Approved major audit/integration gate?** Use Level 6 within the named scope; it is not the default after a fix or milestone.
6. **Exact Release Candidate?** Use Level 7 under the approved certification plan.

The levels describe evidence scope, not a shortcut around required gates: Level 5 may add to a targeted or milestone check; Level 6 and 7 are deliberate audit/certification gates.

## Hosted acceptance and audit budget

Hosted acceptance means operating the deployed product in a browser: login, navigation, forms, role/account switching, approved synthetic state, RSVP/cancel, claim/apply, authorized Test Mode purchase, Wallet, Venue decisions, Promoter links, Scanner and Admin as scoped. Browser evidence is first-class; source review cannot substitute. Use Step 10 for preparation/revisions and Step 11 checkpoints at meaningful boundaries. Never infer a moving staging baseline.

For Level 3, investigate the exact affected behavior deeply enough to reconcile it. For Level 6, maximize safe product coverage; capture a P2 and continue rather than spending half the audit root-causing it. Codex primarily owns Levels 1–2, implementation diagnosis and packaging. Claude primarily owns Levels 3–7 and hosted evidence gathering. These are defaults, not exclusive assignments.

Prefer READY synthetic fixtures; use DISPOSABLE state for destructive acceptance. Preserve canonical READ_ONLY evidence, do not manually repair fixtures to force expected results, and stop when a requirement has not been provisioned/bound. Provider capability is not provider authorization.

## Locked roadmap from harness publication to launch

The following gates preserve the owner-approved sequence. Level 6 is reserved for the named broad gates; ordinary milestones and bounded fixes do not trigger it automatically.

| Gate | Work and acceptance cadence |
| --- | --- |
| A — Harness publication | Finish Steps 13–14, review the harness, scan secrets and references, package PRs, pass CI, then merge/publish to approved repository refs. Publish before relying on it for fresh sessions. |
| B — Guest + Partner comprehensive audits | After publication, close the already-in-flight Guest bounded remediation and targeted re-acceptance if still open; then run Level 6 Guest and Partner audits to expose remaining debt and produce the implementation plan. |
| C — Final Guest/Partner milestone plan | Define exactly three remaining Guest and three remaining Partner milestones, or explain why that structure cannot honestly represent remaining work. Owner approval precedes implementation. |
| D — Remaining Guest/Partner milestones | For each approved milestone: Levels 1–2, staging, then Level 4/5 as appropriate. No automatic Level 6 per milestone; broaden after the group only when impact/risk justifies it. |
| E — Access / Tickets Pass | Implement approved scope only. After deployment use Level 4 plus appropriate Level 5 acceptance. Keep unapproved features out of scope. |
| F — Promoter Pass | After deployment use Level 4 and Level 5 for Promoter → assignment/link → Guest → attribution/order where applicable. |
| G — Scanner / Door Pass | After deployment use Level 4 and Level 5 for entitlement → QR/eligibility → Scanner → valid, denied and duplicate admission state. |
| H — Cross-system monster audit | After Access/Tickets + Promoter + Scanner integration, run Level 6 on same-object journeys across Host, Venue, Promoter, Guest, provider/payment where authorized, ticket, Scanner and applicable Analytics/Admin. |
| I — Experience Quality audit | Audit Guest, Partner and other approved surfaces for hierarchy, copy, loading/empty/error states, interaction, mobile, consistency, perceived performance, trust and product feel. Produce approved EQ findings. |
| J — Experience Quality implementation | Implement approved findings with Levels 1–2; use targeted Level 3/4 after deployment. Do not repeat unrelated provider workflows for presentation-only changes. |
| K — Final adversarial hosted audit | Before RC certification, run Level 6 against the broad risk areas in the approved scope: auth, permissions, event lifecycle, access/tickets, Guestlist, profiling, payments/refunds when authorized, inventory, concurrency, attribution, Scanner/QR, cancellation/postponement, multi-role state, mobile, runtime/provider and performance-critical paths. Record remaining findings. |
| L — Final fixes | Fix launch blockers. Each bounded fix uses Level 1 → Level 2 → Level 3/5 targeted re-acceptance. Do not automatically repeat Level 6. Once final fixes are deployed, proceed to RC certification. |
| M — Level 7 launch certification | Certify the exact intended Release Candidate and configuration. Step 14 owns the certification artifact. Old milestone evidence alone is insufficient. |

The roadmap is a sequence of gates, not permission to perform provider actions, merge, deploy or launch. Each action still needs its required owner authorization; production launch requires owner approval.
