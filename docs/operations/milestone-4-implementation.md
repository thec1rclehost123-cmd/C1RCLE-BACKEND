# Milestone 4 implementation

## Authority and starting state

User authorization: `75e7bc88-7654-41b1-a54b-be7e20774c34/Pasted text.txt` (2026-11-04). Implement the entire six-slice M4 scope, stop before M5. No M4 PR until Slices 1–5, one final affected gate and complete diff review. No M4 deployment ahead of legitimate M3 merge/acceptance. No protection bypass.

- Backend base: `f01c3eb042436c539ab91982f066fffcdac65055` (M3 PR #158).
- Frontend base: `283299f9b90d3d07753ced28855eae4162a4bb50` (M3 PR #92).
- Isolated branch in both repositories: `codex/m4-connected-payments-20261104`.
- Worktrees: `/Users/aayushdivase/Desktop/C1RCLE-M4-BACKEND` and `/Users/aayushdivase/Desktop/C1RCLE-M4-FRONTEND`.
- M3, dirty historical and product-completeness worktrees are preserved separately.

## Founder-approved policy

Guest pays disclosed booking/platform fees. Existing 5% / 2.5% / fee-tax assumptions may be retained only as an explicit, versioned, configurable **non-production test policy**, never claimed as approved production rates. Quote, hold and purchase freeze the full policy and original amounts. Clients never choose rates.

Normal eligible Guest refunds return selected admission value; organizer/platform cancellation or qualifying material changes return full affected original paid components. Allocation uses immutable original snapshots and deterministic paise-safe proration. Preserve approval/execution separation, exact targets and uncertainty locks.

Host eligibility uses canonical effective event end (M3 six-hour fallback): 0 before +24h, at most 75% from +24h, 100% from +72h. Affected refund/dispute/cancellation/reconciliation/provider exposures remain held. No routine permanent reserve. Postponed/frozen schedules cannot mature from old dates. Journal snapshots remain immutable; eligibility never falls back to purchase/posting time. Venue rent excluded. Actual payouts remain OFF.

## Six slices and current state

1. Authoritative paid checkout/holds: implemented locally — server-configurable frozen fee policy; final payability checks after provider binding; durable provider-order claim and receipt recovery; conditional expiry.
2. Confirmation convergence/fulfillment: implemented locally — create-if-absent ticket issuance, canonical pending/complete marker, exact financial/product/outbox completion and structured receipt facts; Wallet/management/Scanner gate pending rights.
3. Failure/expiry/restart recovery: implemented locally — bounded stranded-capture repair and no blind provider retries; captured purchases unable to grant admission become full-original-payment canonical compensation requests with existing approval thresholds. No direct compensation refund POST.
4. Connected exact-ticket refunds: local backend implemented — original component allocation, atomic intake, event-version guards, approval-gated compensation and fee-only policy remedies, cancellation full-remaining-original policy. Admin/Guest frontend integration implemented and focused checks passed. Real provider payment/refund acceptance remains UNVERIFIED.
5. Reconciliation/disputes/settlement: implemented locally — legitimate M3 states, affected exposure holds, staged event-end eligibility, explicit Partner journal linkage and bidirectional reversal with transactional refund/correction guards. Unlinked or mixed-scope claims require a separately approved adjustment; provider chargebacks remain distinct.
6. Final integrated acceptance: local affected gate and targeted connected/browser acceptance passed with qualifications below. Ordinary features are frozen and complete diffs reviewed. Consolidated PR/CI and legitimate M3→M4 staging/real Razorpay Test acceptance remain; M4 is not complete.

### Founder dispute decision

The founder selected: reverse the identified disputed entry; require a separate approved adjustment for unlinked claims. Exact canonical journal IDs, or the persisted `legacy_backfill` source link to an identified legacy entry, establish identity. Never infer linkage from equal amounts. Whole balanced reversals must concern the exact single-Partner payable scope; unrelated, mixed-scope and provider payout/chargeback facts retain their separate authority.

### Focused evidence to date

These are separate focused runs, not a cumulative unique-test count or the final comprehensive gate:

- UNIT VERIFIED: pricing/order snapshot tests; 18 posting tests including distinct fee caps/replay and refund after Partner reversal; 3 canonical compensation intake tests; 25 staged settlement tests; 18 dispute/correction tests including native cases below.
- EMULATOR VERIFIED: conditional expiry/issuance regressions, native provider-claim/intake/completion races, and 4 native/memory correction cases. Tests use disposable demo projects on loopback, never production.
- LOCAL HTTP VERIFIED with Memory provider: 70 affected checkout/payment/webhook tests; 57 refund tests at cancellation checkpoint; 2 focused subsequent policy-remedy cases (55 unrelated cases unselected); 1 focused financial fee-settings authority/version/audit case (10 unselected); 7 Admin dispute tests.
- Frontend focused tests/typechecks passed for Test fee disclosure/policy version reconfirmation, staged Host settlement/payout-disabled behavior and Admin uncertain-refund recovery. Browser acceptance was pending at this focused checkpoint; final evidence follows below.
- RAZORPAY TEST MODE VERIFIED, order adapter only: one real Test order creation and later exact read-only lookup/recovery; no second creation after uncertain lookup. No real Test payment/capture/refund claimed.
- FIREBASE c1rcle-v2 READ ONLY: protected metadata probe confirmed no Emulator configured, absent journal-transition singleton and no persisted M4 booking policy; existing accounting policy version is `m2-test-policy-v1`. No writes attempted. Therefore the default legacy finance mode remains unavailable for M4 settlement until a governed cutover; this work does not silently migrate it.

Evidence artifacts: `/Users/aayushdivase/Desktop/C1RCLE-M4-VERIFICATION-20261104`. Preserve failed reproductions and subsequent focused results. Local commits are checkpoints, not PR/deployment authorization.

## Safety and verification

Approved connected project: `c1rcle-v2`, Razorpay **Test Mode only**. No production money/data/cutover. Local native tests may use disposable Emulator projects. No real provider facts inferred from synthetic fixtures. Workers default safely OFF; inline dispatch is separately accounted for. Payouts explicitly OFF. Never expose provider secrets to frontend, logs or commits. Do not import side-track candidates or add a competing email/finance system.

Use focused regression/unit tests during changes, native Emulator tests for transaction races, real Redis only for shared coordination, and targeted browser tests for changed UI. Do not repeat broad suites after small edits. Preserve failed reproductions and classify UNIT / EMULATOR / REDIS / LOCAL CONNECTED / RAZORPAY TEST MODE / BROWSER / STAGING evidence honestly.

M3's required independent backend review remains an external hosted-release dependency, not a blocker to local M4 implementation. Real provider payment/refund and hosted acceptance remain unverified. Local browser evidence and its qualifications are recorded below. Hosted release still requires the legitimate M3 process.

## Preserved M5 boundary

Venue cover sales and ticket add-on sales remain OFF (`M5_COVER_SALES_ENABLED=false`, `M5_TICKET_ADDONS_ENABLED=false` by safe defaults); M4 does not activate their separate commercial/accounting capabilities. Bounded dependency review found the older cover integration permits only full unused full-order refunds. Exact unused organizer cover remedies could eventually use per-entitlement saved policies, but normal admission-only refunds would void the linked admission and leave cover rights unresolved. The future cover authorization must decide whether to refund unused cover, preserve an independent redeemable right, or make combined products ineligible for that normal refund. No such new policy or cover implementation is authorized by M4; existing fail-closed cover behavior is preserved.

## Historical pre-gate feature freeze checkpoint

Ordinary M4 feature implementation is frozen. Subsequent changes require a demonstrated gate/runtime defect or required acceptance correction; no speculative failure sweeps or M5 work.

Frontend checkpoints: `f4a6b4e` (fees/settlement/recovery), `501ffc6` (durable booking/refund UI), `08ddc25` (observed missing-poster checkout defect), `2240977` (admission refund status and exact Admin paise). The backend integrated checkpoint follows the two earlier safety commits.

BROWSER VERIFIED with isolated synthetic Emulator fixtures: Guest fee quote/checkout at desktop and phone, paid-pending/compensation-pending confirmation without false admission/refund success, Host staged policy/legacy eligibility unavailable/payout disabled, and Admin uncertain-refund controls. Admin initial authentication failures recovered through the existing real refresh flow; preserve this qualification, not a clean-network claim. Purchase receipt browser rendering remains UNVERIFIED. No provider refund/reconciliation button was invoked. The Admin money formatter and opaque compensation requester defects were reproduced and fixed with focused regressions; their final UI checks remain in acceptance.

Terminal refund retries now repair deterministic receipt/audit intents with persisted execution attribution; no provider/ticket/journal repetition. Payment identity guards reject a different capture on an already-converted hold. A scalar admission-refund state prevents retained fees from making fully refunded admissions look confirmed.

Final comprehensive affected gate: NOT YET RUN at this checkpoint. Native/local settlement matrix is separate controlled synthetic acceptance, not real provider money. Real Razorpay purchase/refund, callback/webhook races against M4 and hosted staging acceptance remain UNVERIFIED. M3 backend PR #158 was rechecked OPEN / REVIEW_REQUIRED / BLOCKED at the unchanged frozen head; frontend #92 remains OPEN and clean. No M4 push, PR or deployment has occurred.

## Final review corrections before the comprehensive gate

Local independent diff review found and resolved four additional integration boundaries:

- Fee settings now use a server-only CAS revision and immutable version records in the existing settings collection. Concurrent same-version/different-term writes and changed historical version reuse are rejected; exact rollback is permitted. Memory/native regressions: 6 passed; affected settings/Admin tests: 20 passed; independent source review clear. Existing singletons without a revision begin at zero; no real project migration or settings write was performed.
- Proven zero-rights compensation now reconciles without invented missing-ticket/orphan findings. Exceptions require original snapshot, full canonical request, provider/hold binding and posted journal evidence; any issued right remains a discrepancy. Focused reconciliation tests: 21 passed.
- Owner financial confirmation survives unavailable public event details, and an unresolved `requires_support` attempt retains its recovery pointer and blocks replacement payment creation. Guest focused tests: 63 passed; types/lint/format passed.
- New holds freeze the original sale allocation and commercial identities, then copy them to paid orders. Accounting precedes issuance. Accounting-only repair handles cancellation/refund locks, repairs missing original journals/companion lines and fills only missing immutable compatibility legs. Refund execution checks this before contacting the provider. Missing legacy allocation evidence creates durable finance review and retains locks; it never guesses current commercial terms. Corrective tests: 71 Core, 17 native Firestore, 74 Gateway HTTP; Core types/scoped lint/format passed. Original finder reviewed the correction without new findings.

The accounting-only refund fast path verifies the mandatory collection/allocation pair and restores stored companion lines. It does not invent an isolated missing conditional provider-fee aggregate from an otherwise existing pair. New capture posting writes its known provider fee atomically, and new fulfillment separately requires the conditional fee proof. This is a recorded recovery limit, not a claim of arbitrary historical financial reconstruction.

Code checkpoints now include backend `675849e`, `f81ca5e`, `56ee9c1` and frontend `79034f6`, following the integrated checkpoint. The reviewed comprehensive gate is prepared as 45 sequential steps outside source, with two file workers for this 8 GB machine; concurrency operations inside race tests and existing timeouts are unchanged. The gate has NOT been executed at this documentation checkpoint. Only demonstrated verification/acceptance failures may change the frozen candidate from here.


## Final local gate and connected acceptance — 2026-11-04/05

Application checkpoints: backend `9b4e302` and frontend `b8ad579`. Subsequent evidence-only documentation commits do not change application behavior. Exact frozen M3 ancestors remain preserved; unrelated worktrees were not reset or cleaned.

The single accumulated comprehensive affected gate passed: **45 steps passed, 1 not applicable, no test skips**. The original 45-step plan passed, then final native acceptance demonstrated the optional-audit-metadata defect below. One bounded regression step was added; only affected backend type/lint/format/build checks resumed. Earlier successful evidence retains its recorded revisions; this is explicitly mixed-revision evidence, not an exact-head claim for every earlier test. No original assertion, concurrency operation, timeout or gate was weakened.

| Stage | Passing tests |
| --- | ---: |
| Backend contracts | 39 |
| Core affected invariants | 594 |
| Memory repositories | 15 |
| Native Firestore/concurrency | 121 |
| Gateway routes/adapters | 478 |
| Real Redis rate limiting | 18 |
| Post-acceptance Admin/refund/native regression | 22 |
| Guest affected | 166 |
| Admin refund/format | 41 |
| Partner finance | 101 |
| Frontend contracts / API client / config | 7 / 54 / 11 |

These are separate stages, not a unique cumulative total. Contracts/export/parity, types, backend/shared builds, architecture boundaries, indexes, nginx, security action pins/history, affected lint/format, all three Next production builds and Scanner Web export passed. The Scanner affected-lint selection was not applicable because no Scanner source changed; its types/export did run. Exact argv, failed attempts, source heads and reviewed resumptions are preserved in the external `final-gate/plan.json`, `state.json`, `logs/` and `reports/`.

Demonstrated final-gate/runtime corrections:

- Initial version-one Order creation is create-if-absent in native and Memory repositories. A stale create cannot overwrite completion or refund locks. The losing concurrent confirmation follows the common provider-binding path, including recovery when the winner's final binding was interrupted.
- Captured purchases queued for compensation grant no admission and consume neither sold inventory nor paid-unit quota. Ordinary paid-pending claims remain protected. Original buyer races/counts and timeouts were retained.
- Canonical Admin audit writes omit undefined optional IP/User-Agent fields while preserving supplied values, including empty strings. Native regressions reproduced three serializer failures before the fix; six cases passed afterward, including immutable actor evidence. No adapter/global `ignoreUndefinedProperties` workaround was added.
- Older finance test fixtures now explicitly opt in to in-memory payout-route scenarios and use journal-backed, provider-evidenced, ended-event proceeds. Deployment defaults remain OFF. Original route/replay/reservation assertions remain.

LOCAL CONNECTED / EMULATOR VERIFIED: actual Host/Venue/event/quote HTTP journey; original versioned pricing; native canonical Memory-provider purchase completion and exact all-admission refund with a distinct authorized approver; same-request recovery after the audit interruption; balanced journals, receipt/outbox facts, exact ticket invalidation and stable terminal retry. Native settlement passed 11 actual Host API cases across the staged clock, affected holds and missing-end fallback. Governed journal transition occurred only in disposable `demo-c1rcle-m4-local`; real `c1rcle-v2` settings/transition were not changed.

BROWSER VERIFIED against production Guest/Admin builds: pending, compensation with actual public-event 404, original receipt and all-admission refund retaining fees, each at 1440/390px. Original payment ₹1,087.43, refund ₹999.01, retained ₹88.42 remain exact; refunded admissions show no active ticket CTA. Stranger order API returns 404 and the UI exposes only unavailable-booking/noindex, no financial facts. A streamed Next not-found document may return 200 ([official semantics](https://nextjs.org/docs/app/api-reference/file-conventions/not-found)); the initial harness's document-status assumption was corrected and only security/Admin checks resumed. Owner-state evidence was preserved rather than rerun.

Admin current canonical compensation amount ₹1,088.5 and pending state were browser verified; no financial action was clicked. This is **qualified** evidence: five initial 401 responses were recorded. The two refund requests recovered after refresh to 200; three initial dashboard-prefetch endpoints were not rechecked. It is not a clean-network claim. Existing Host settlement/payout-disabled and Admin recovery-control browser evidence remains separate. No Auth/KYC/Profile side-track was imported.

The first receipt harness generated overlong synthetic identifiers. Its native failure/recovery evidence was retained; it was not accepted as browser proof. A private lossless snapshot and exact transactional membership/version checks quarantined only its 78 owned invalid-fixture documents in the disposable Emulator. Shared identities, event/tier, settings, journal transition, sequence and unrelated records were preserved. Corrected V2 fixture IDs are validated against the existing contract before acquisition. Application contracts were not relaxed.

Evidence root: `/Users/aayushdivase/Desktop/C1RCLE-M4-VERIFICATION-20261104/FINAL_M4_LOCAL_EVIDENCE.md`. Browser results, native fixtures and failed attempts remain in `local-connected/`. These Memory-provider facts are **not Razorpay observations or email-delivery evidence**.

## Release and remaining acceptance

Frontend `b8ad579` adds exact-M4-branch `git.deploymentEnabled=false` in all three app configs to prevent previews before M3 ([Vercel configuration](https://vercel.com/docs/project-configuration/git-configuration)). Other branch rules are unchanged. Render remains `autoDeploy=false`; CI deployment acts only on a successful staging push. Opening the consolidated PRs does not authorize M4 staging ahead of M3.

Both CI parity repository variables currently select staging, which lacks the paired M3/M4 contracts. The existing backend `frontend_ref` and frontend `backend_ref` workflow-dispatch inputs support exact-pair CI without changing those variables or protections. Preserve any automatic staging-parity mismatch and distinguish supported exact-pair CI evidence; never claim current staging contains the candidate.

RAZORPAY TEST ORDER ONLY VERIFIED: one real Test order creation plus later exact read-only recovery. Real Test payment/capture/refund, hosted callback/webhook races and M4 staging acceptance remain UNVERIFIED. M3 backend #158 still requires legitimate independent review/merge/hosted acceptance before M4 merge/deployment. No bypass, production/Live operation, real-project finance cutover, worker/payout enablement or M5 work is included. Full M4 remains incomplete until its required hosted/real Test acceptance passes.


### Required pre-push fixture correction

The repository's unmodified pre-push hook additionally ran its full unit-test gate. The first attempt stopped publication: contracts passed 39; Core passed 1322 with 166 conditional integration skips; Gateway passed 1163 with four failures and five conditional skips. Skips are not passes and do not replace the separately verified native/Redis stages. All first-attempt package logs were preserved.

The four failures were outdated fixture assumptions, corrected in `0656f88`: the production actor-denial fixture explicitly selects approved `c1rcle-v2` (config/actor only, no database operation), and three in-memory payout release/batch/RBAC tests explicitly opt in so they exercise their original assertions behind the new safe default. Runtime guard code and all authorization assertions are unchanged. The three focused suites passed 16 tests. The original Gateway affected stage now includes both demonstrated affected files and passes 478 tests; backend types/affected lint/format passed again. Unchanged financial/native/browser/build evidence was retained. Required hooks and normal CI are not bypassed.


### Post-PR CI corrections

Consolidated draft PRs are backend #159 and frontend #93. The first normal backend CI passed static analysis, commit messages, build/tests/coverage, actionlint and the Security workflow. It demonstrated three separate failures, preserved in the external CI logs:

- Automatic contract parity selected frontend staging `6c51dda`, which lacks M3 `managedTicketSchema`; it cannot represent the frozen M4 pair. Supported exact-pair workflow inputs are required; repository variables/protections are unchanged.
- Container Trivy found HIGH `CVE-2026-109518` in APT/libapt 2.6.1. Debian identifies Bookworm security 2.6.2 as fixed ([tracker](https://security-tracker.debian.org/tracker/CVE-2026-109518)). `3d14699` installs the actual updates, makes the existing Debian12 variant explicit, installs the actual package-manager version from the repository manifest before invoking pnpm, and removes a legacy dependency-version label rewrite. Non-root user, entrypoint, health probe and runtime flags are preserved. Static invariants and six RUN shell-syntax checks passed. Local Docker daemon is unavailable; image build/scan/boot are explicitly pending CI, with no scanner suppression or fabricated local success. The real installed pnpm11.26.0 bundle has tar7.5.22; metadata rewriting is not a substitute for patched code.
- Full native CI passed174 tests and reported seven conditional skips, then failed one pre-existing add-on inventory fixture because its canonical paid quote lacked partnership/onboarding repositories. `c73d0d0` supplies those two dependencies; the original concurrent final-unit assertion passed natively, unchanged. Application feature flags are unchanged; this is fixture maintenance, not M5 implementation.

Only demonstrated CI failures were corrected. The complete pre-PR affected gate and browser evidence remain recorded at their original revisions; unchanged application behavior was not subjected to another speculative broad sweep. Normal hooks and CI still apply to the updated candidate. Frozen M3 worktrees/heads remain unchanged; its legitimate release process must obtain current container-security proof before any hosted release.

The next normal backend CI passed the native Firestore stage and cleared the APT findings. Container scanning then identified four HIGH Undici advisories in the installed pnpm11.26.0 bundle (Undici6.28.0), rather than in the application lockfile. The central package-manager pin is updated within major11 to pnpm11.28.10. Before installation, its registry archive was SHA512-integrity verified and inspected without executing scripts: it contains actual Undici6.29.1 and tar7.5.22. Undici6.29.1 is the patched release identified by the [upstream advisory](https://github.com/nodejs/undici/security/advisories/GHSA-2m5v-pch6-74hx). Docker already installs the manifest's exact package manager, so this updates the actual bundled code without dependency metadata rewriting or scanner exceptions. Application dependencies and lockfile remain unchanged. Frozen installation, required hooks and normal image build/scan/boot CI must verify the corrected candidate; local archive inspection alone is not container acceptance.

Normal CI `41967608901` on `86de857` passed static analysis, commit checks, build/tests/coverage, native Firestore, Docker build/scan/boot/config rejection and actionlint; Security `41967608875` passed. The automatic parity failure still used old frontend staging. Supported exact-pair run `41968124133` verified parity against frontend `b8ad579`, but exposed a scenario-runner setup failure before executing any scenario: its webhook-only fixture violates the new complete-provider-tuple guard. The scenario runner now supplies the same complete synthetic Test tuple as the existing unit runner; no runtime guard, scenario assertion or timeout is changed. All five scenarios passed locally on the memory driver with provider/email credentials removed and workers/payouts explicitly off. These are synthetic application scenarios, not real provider acceptance. Normal hooks/CI and the exact-pair workflow still apply to this final fixture correction.
