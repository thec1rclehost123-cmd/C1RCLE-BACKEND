# Milestone 3 implementation — active, not accepted

Authorization: 2026-11-04 implementation attachment `8612bbed-98ec-4f34-bf0d-f2c182fe36ef/Pasted text.txt`; business baseline `C1RCLE_M3_CONTEXT_BOOTSTRAP_REVISED.txt`. M1/M2 are closed. This milestone does not authorize production cutover or provider payment/refund/payout execution.

## Baseline and preservation

Backend candidate: `codex/m4-m5-lineage-reconcile-20261029`, staging `353999712a63fa74c61d4b60c67e3a2450585ca2`. Frontend candidate: same development branch, staging `6c51ddaee3bc9a401a64994f6f010f3b9058ab68`. Both remote staging references reconfirmed unchanged after fetch during final local verification.

The nine completed frontend layout files were preserved in local commit `7aa815b` after six focused tests and scoped style checks. Partner lifecycle/inventory work is checkpointed in `7e52a5e`; tested studio-context/mobile-control corrections in `bbd72bd`. All travel together; no separate cosmetic PR. The original dirty M4/M5 lineage directories remain untouched. Old management scaffolding was reused selectively, without wholesale merging preserved work.

## Implemented behavior

- Canonical postponed state; central admission/QR/transfer gates; admission closes end minus five minutes, with legacy start plus six-hour end. Material change is any venue change or schedule shift greater than twelve hours. Event changes and notification facts persist atomically through the existing outbox. Venue cancellation freezes the event and records its initiator, Host inbox notification and deterministic Admin support case.
- Independent tier capacity, safe increases and transactional sold-plus-held decrease protection. Quantity-based pricing phases have allocation snapshots. Student/Member and waitlists are unavailable; no new provisional flags enabled. Existing commercial prices and attribution stay immutable.
- Verified-account paid acquisition. Atomic Free RSVP order/ticket/outbox allocation shares the inventory transaction sequence with holds. Self-cancellation voids its credential and releases exactly once.
- Purchaser, holder and explicit unassigned state remain distinct. Null-holder correction covers reads, issuance, Wallet, invitations, Scanner, cover and Admin projections. V1 transfers use exact verified email, current event checks and a five-minute cutoff without enabling M5/offline features. Invitation delivery uses a validated Guest origin.
- Management/roster/recipient-preview APIs and Guest BFF routes drive Wallet. Authoritative management is required before credential requests; no fallback QR. QR is holder-only and starts twenty-four hours before the current event start. Postponed Wallet dates are TBA; cancelled state is immediate. Material notices and exact event titles remain intact.
- Refunds target exact ticket identities through existing M2 locks/recovery. Settled ticket inventory releases use immutable metadata. Guest Request Refund creates a durable, idempotent review case in the existing Admin support queue; separate existing Admin financial approval/execution remains required. No provider refund executed.
- Male/Female requirements use Guest acknowledgment and door confirmation, independent of profile gender. Couple remains one paired admission with both-or-neither semantics.
- Camera and manual Scanner admission share authorized session/device, event/window, holder, credential, refund and category checks. Successful ticket consumption, scan ledger and admission fact commit atomically. Scope checks conceal wrong-event ticket details. No reentry or unsafe override. Local phone pair controls and ticket-dialog stacking defects were corrected after runtime observation.

## Local final integration gate

The complete accumulated Slice 1–5 candidate passed its local gate, with the initial failures and focused corrections retained honestly. It received one comprehensive gate. Raw commands, results, retained initial failures and focused corrections are recorded under `/Users/aayushdivase/Desktop/C1RCLE-M3-VERIFICATION-20261104/final-gate/` (`results.json`, `corrections.json`, individual logs and test JSON reports). Do not add overlapping test counts.

- FOCUSED TESTED: comprehensive backend run: 2,294 passed, 100 skipped, one obsolete contract assertion failed. The corrected contract suite then passed all six tests; runtime policy was unchanged. The skipped native cases are not passes.
- EMULATOR-TESTED: final native set, 13 suites / 42 tests passed, zero skips. Covers tier/hold allocation, atomic RSVP acquisition and cancellation, lifecycle/outbox persistence, admission/duplicate/refund/transfer races and exact refund inventory release, including existing M2 recovery regressions.
- Five business scenarios passed using explicit verified synthetic accounts, current event times and genuine locally minted signed QR payloads. No provider operation.
- Guest accumulated affected set: 93 passed and one unavailable-ticket recovery UI regression failed. Its original named region and refresh action were restored; focused two-test suite and scoped lint then passed. Three earlier authoritative Wallet mapping regressions failed before the six-hour/venue correction; mapping16/16 passed afterwards.
- Partner affected tests and Admin refund-review tests passed. Frontend TypeScript gate: all29 Turbo tasks passed. Backend Core/contracts types passed; the Gateway's explicit reply type was corrected, and its scoped full typecheck passed.
- Backend boundaries and Firestore index coverage passed. Backend/frontend format checks passed; eleven backend import-order/duplicate-import errors were corrected and the affected files rechecked. All affected frontend application lint checks passed.
- Backend production builds, all three Next application builds and263 behavioral contract parity cases passed. Guest was rebuilt after its final corrections. Scanner exports compile iOS, Android and Web; the targeted runtime check exposed an invalid local export setting retained in Metro's cache. Configuration evaluation verified staging, followed by a staging-configured cache-cleared export; no application policy was relaxed.
- Local synthetic Guest browser: desktop1440x1000 and phone390x844 passed unassigned and early-QR gating with zero credential requests, unavailable-ticket refresh and invitation controls. Zero console/page errors. A real hydration error from the invitation portal was reproduced, fixed by reusing the existing mounted hook, and verified with six focused tests plus this final browser run.
- Partner local phone/desktop event editor and Scanner pair/manual browser evidence are retained separately. These are synthetic API fixtures, not connected staging, provider delivery or native-device evidence. The final exported Scanner runtime passed: pair rejection consumed zero; accepted pair consumed two; manual admission submitted explicit pair/eligibility confirmation; the deferred sale control was disabled; no unsafe override, console/page/network errors.
- Bounded independent final review found no concrete release blocker in lifecycle, custody, transactional admission/transfer, verified-email binding, Scanner wiring and Wallet corrections. This is not a claim of exhaustive line-by-line review.

Browser artifacts: `/Users/aayushdivase/Desktop/C1RCLE-M3-PARTNER-LOCAL-20261104`, `C1RCLE-M3-SCANNER-LOCAL-20261104`, `C1RCLE-M3-GUEST-LOCAL-20261104`. Preserve earlier failure evidence and distinguish test harness configuration failures from product failures.

## Local checkpoints and release sequence

Core/contracts checkpoint `f089166`, Scanner fixture checkpoint `618c9cd`, Gateway checkpoint `923cc32`, reply/import correction `e7cbadb` and contract expectation checkpoint `278f0e9`. Frontend contracts `1363760`, Guest `6b0607a`, Admin `9ff588e`, Scanner `84c6d18`, Wallet effective-end/venue `b1f201b`, unavailable recovery `91f4c64` and invitation hydration `0d3d562`, following the preserved Partner checkpoints above.

User clarification: finish the entire local M3 candidate; close this final integration gate and review the accumulated frontend/backend diffs; then one consolidated frontend PR and one backend PR into staging, normal existing CI/hosting, connected acceptance. No intermediate or cosmetic PR/deployment. No main merge or new infrastructure. A later corrective PR requires a demonstrated staging defect and its affected-surface correction.

## Connected completion gate — still open

This document is the local pre-PR checkpoint. No push, PR, deployment or connected M3 acceptance has occurred at this checkpoint. M3 is NOT COMPLETE.

CONNECTED NON-PRODUCTION evidence remains mandatory: approved Host configures/publishes event and tiers; real authenticated final-seat RSVP acquisition; custody, assignment/exact-email acceptance, transfer, Wallet and QR; Scanner rejection without consumption, exactly-once admission and duplicate rejection; material change, postponement and cancellation effects. Configure `GUEST_PORTAL_URL` to the actual authorized staging Guest origin before invitation verification, preserving existing origin trust and auth constraints. Do not treat Guest/Admin canonical main deployments as staging acceptance.

Final authoritative/staging revisions, PRs, CI and connected scenarios belong in the M3 final evidence report. Local fixture-driven browser checks, source tracing and native Emulator results cannot substitute for connected acceptance. Physical device/camera and provider evidence must retain their distinct labels.

## Deliberately deferred

Provider checkout/capture/refunds/payouts, production release, full email design, offline Scanner/advanced M5, Student/Member, waitlists, resale, broad load work and full Promoter analytics/E2E. Promoter frozen purchase attribution and refund reversal behavior remain protected by existing paths and affected regressions.
