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
6. Final integrated acceptance: pending — final affected integration gate, complete diff review and frozen revisions; ordinary feature work is frozen, complete diff review and frozen revisions before consolidated PRs.

### Founder dispute decision

The founder selected: reverse the identified disputed entry; require a separate approved adjustment for unlinked claims. Exact canonical journal IDs, or the persisted `legacy_backfill` source link to an identified legacy entry, establish identity. Never infer linkage from equal amounts. Whole balanced reversals must concern the exact single-Partner payable scope; unrelated, mixed-scope and provider payout/chargeback facts retain their separate authority.

### Focused evidence to date

These are separate focused runs, not a cumulative unique-test count or the final comprehensive gate:

- UNIT VERIFIED: pricing/order snapshot tests; 18 posting tests including distinct fee caps/replay and refund after Partner reversal; 3 canonical compensation intake tests; 25 staged settlement tests; 18 dispute/correction tests including native cases below.
- EMULATOR VERIFIED: conditional expiry/issuance regressions, native provider-claim/intake/completion races, and 4 native/memory correction cases. Tests use disposable demo projects on loopback, never production.
- LOCAL HTTP VERIFIED with Memory provider: 70 affected checkout/payment/webhook tests; 57 refund tests at cancellation checkpoint; 2 focused subsequent policy-remedy cases (55 unrelated cases unselected); 1 focused financial fee-settings authority/version/audit case (10 unselected); 7 Admin dispute tests.
- Frontend focused tests/typechecks passed for Test fee disclosure/policy version reconfirmation, staged Host settlement/payout-disabled behavior and Admin uncertain-refund recovery. Actual M4 browser acceptance remains pending.
- RAZORPAY TEST MODE VERIFIED, order adapter only: one real Test order creation and later exact read-only lookup/recovery; no second creation after uncertain lookup. No real Test payment/capture/refund claimed.
- FIREBASE c1rcle-v2 READ ONLY: protected metadata probe confirmed no Emulator configured, absent journal-transition singleton and no persisted M4 booking policy; existing accounting policy version is `m2-test-policy-v1`. No writes attempted. Therefore the default legacy finance mode remains unavailable for M4 settlement until a governed cutover; this work does not silently migrate it.

Evidence artifacts: `/Users/aayushdivase/Desktop/C1RCLE-M4-VERIFICATION-20261104`. Preserve failed reproductions and subsequent focused results. Local commits are checkpoints, not PR/deployment authorization.

## Safety and verification

Approved connected project: `c1rcle-v2`, Razorpay **Test Mode only**. No production money/data/cutover. Local native tests may use disposable Emulator projects. No real provider facts inferred from synthetic fixtures. Workers default safely OFF; inline dispatch is separately accounted for. Payouts explicitly OFF. Never expose provider secrets to frontend, logs or commits. Do not import side-track candidates or add a competing email/finance system.

Use focused regression/unit tests during changes, native Emulator tests for transaction races, real Redis only for shared coordination, and targeted browser tests for changed UI. Do not repeat broad suites after small edits. Preserve failed reproductions and classify UNIT / EMULATOR / REDIS / LOCAL CONNECTED / RAZORPAY TEST MODE / BROWSER / STAGING evidence honestly.

M3's required independent backend review remains an external hosted-release dependency, not a blocker to local M4 implementation. Real payment/refund, browser and hosted acceptance remain unverified. Hosted release still requires the legitimate M3 process.

## Preserved M5 boundary

Venue cover sales and ticket add-on sales remain OFF (`M5_COVER_SALES_ENABLED=false`, `M5_TICKET_ADDONS_ENABLED=false` by safe defaults); M4 does not activate their separate commercial/accounting capabilities. Bounded dependency review found the older cover integration permits only full unused full-order refunds. Exact unused organizer cover remedies could eventually use per-entitlement saved policies, but normal admission-only refunds would void the linked admission and leave cover rights unresolved. The future cover authorization must decide whether to refund unused cover, preserve an independent redeemable right, or make combined products ineligible for that normal refund. No such new policy or cover implementation is authorized by M4; existing fail-closed cover behavior is preserved.

## Local feature freeze checkpoint

Ordinary M4 feature implementation is frozen. Subsequent changes require a demonstrated gate/runtime defect or required acceptance correction; no speculative failure sweeps or M5 work.

Frontend checkpoints: `f4a6b4e` (fees/settlement/recovery), `501ffc6` (durable booking/refund UI), `08ddc25` (observed missing-poster checkout defect), `2240977` (admission refund status and exact Admin paise). The backend integrated checkpoint follows the two earlier safety commits.

BROWSER VERIFIED with isolated synthetic Emulator fixtures: Guest fee quote/checkout at desktop and phone, paid-pending/compensation-pending confirmation without false admission/refund success, Host staged policy/legacy eligibility unavailable/payout disabled, and Admin uncertain-refund controls. Admin initial authentication failures recovered through the existing real refresh flow; preserve this qualification, not a clean-network claim. Purchase receipt browser rendering remains UNVERIFIED. No provider refund/reconciliation button was invoked. The Admin money formatter and opaque compensation requester defects were reproduced and fixed with focused regressions; their final UI checks remain in acceptance.

Terminal refund retries now repair deterministic receipt/audit intents with persisted execution attribution; no provider/ticket/journal repetition. Payment identity guards reject a different capture on an already-converted hold. A scalar admission-refund state prevents retained fees from making fully refunded admissions look confirmed.

Final comprehensive affected gate: NOT YET RUN at this checkpoint. Native/local settlement matrix is separate controlled synthetic acceptance, not real provider money. Real Razorpay purchase/refund, callback/webhook races against M4 and hosted staging acceptance remain UNVERIFIED. M3 backend PR #158 was rechecked OPEN / REVIEW_REQUIRED / BLOCKED at the unchanged frozen head; frontend #92 remains OPEN and clean. No M4 push, PR or deployment has occurred.
