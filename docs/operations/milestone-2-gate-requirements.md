# Milestone 2 gate requirements

Status after authorized remediation: **BROAD GATE NOT RUN / BLOCKED**. The user authorized remediation and a once-only broad gate if remaining blockers permit a meaningful run. Index remediation and the local safety profile are verified; secret/provider/topology blockers remain. See [remediation and pending decisions](milestone-2-remediation.md). Do not start Milestone 3 or mark Milestone 2 complete from packet-level tests or formal blocker records.

## Mandatory unresolved requirements

- [x] A2 local protected signing/HMAC binding and explicit session revocation: three independent 256-bit values in macOS Keychain, 818 sessions revoked, final session count zero, five real old raw bearers rejected. No account/commercial mutation. Fresh connected password login and delivered OTP/Scanner acceptance remain unverified; isolated library/crypto checks are not substitutes. See [A2 execution](milestone-2-remediation.md). The protected launcher is required; bare development startup still lacks the binding.

- [x] **The fourteen reviewed missing indexes were additively deployed to `c1rcle-v2` under explicit approval.** All 14 reached READY; deployed count 72 to 86; pre-existing indexes preserved. All 26 previously failing affected plans pass with `analyze:false` (12 source shapes and 14 exact definition shapes with overlapping coverage). This satisfies the index gate requirement; it does not prove worker or business-workflow execution. Historical Packet 2.4 evidence remains intact; current closure is recorded in [remediation evidence](milestone-2-remediation.md).
- [ ] Resolve remaining bank-key and runtime/connected secret-verification requirements in [Packet 2.5 evidence](provider-configuration-readiness.md), through an approved secure configuration/rotation procedure. Do not print or commit values.
- [ ] Record the existing Resend provider/domain operational evidence (operator reports verified domain, existing Sending access key and prior Delivered emails), establish the current Gateway runtime binding, and verify Razorpay Test Mode webhook configuration evidence, or retain explicit blocked status. Credential presence and mocked tests are insufficient. Provider-dependent acceptance remains subject to its separate connected-workflow authorization.
- [ ] Preserve Packet 2.3's **UNVERIFIED historical Firestore startup-timeout cause**. Successful current cold/warm samples and the overlapping-probe fix do not reconstruct its missing error/timing record. Retain this uncertainty; further claims require a safe reproduction or additional historical evidence.
- [x] Verify the approved local acceptance profile: `c1rcle-v2`, Firestore, Test Mode-shaped credentials, payouts/workers/offline/provisional flags false, offline-drain attestation false. Twelve explicit flags applied only to ignored Gateway `.env.local`; unrelated lines preserved. No Gateway started. Recheck effective flags on any later launch; hosted staging configuration remains unverified.
- [ ] Reconcile the M1 gate's 63 unverified skipped cases by their assigned domain/final gates. Do not silently erase or count them as passed. Distinguish these retained skips from deliberately deselected packet tests.

The 14-index deployment was explicitly approved and completed. Secret/provider changes still require separate approval. An authorized diagnostic gate may still record blockers; it cannot truthfully produce a clean pass while required evidence is unresolved.

## Once-only relevant milestone verification, when authorized

Run the relevant stable backend/Core/Gateway/refund checks once; affected typechecks, targeted lint/format/boundaries, appropriate narrow/full relevant Emulator and Redis checks, exact-pair contracts only where changed, and safe startup/readiness checks. Keep full-suite runs out of ordinary packet editing.

Record exact local source manifests/SHAs, command exits, failures, warnings, skips, connected versus synthetic evidence, cleanup and remaining blockers. Verify the cumulative M1/M2 changes remain preserved. A passing local suite is not connected provider acceptance, a deployed index, a rules change or permission to release.

Stop for review after the Milestone 2 gate. No commit, push, PR, merge, CI trigger, staging modification or production release is implied by gate authorization.

## A3/A5 latest local configuration status

A3 is now provisioned in the approved non-production macOS Keychain and synthetic reload/rejection/masking checks pass through the protected launcher. A5 remains BLOCKED: no reusable Resend secret was located in approved local protected custody; no credential is bound and no email was sent. Earlier pending-authorization/missing-bank-key statements are historical. Workers/payouts/offline/provisional features and drain attestation stay false. No broad gate or hosted/Razorpay work ran. See [the bounded execution record](milestone-2-remediation.md#a3--a5-bounded-configuration-execution--2026-11-03-local).

## A5 binding update — 2026-11-03 local

The operator-provisioned dedicated non-production Resend key now loads from the approved Keychain entry through the existing protected launcher. Actual Gateway configuration and adapter initialization passed, with all safety flags false and zero send/provider/outbox actions. The previous missing-local-key blocker is superseded; provider key validity and actual delivery remain UNVERIFIED pending a separately approved controlled send. Thirty focused configuration/mocked-adapter tests passed without skips. See [the binding execution record](milestone-2-remediation.md#a5-protected-local-binding-completed--2026-11-03-local). A6/A7 and the broad gate were not started.

## Launcher authorization resolved; one Resend message accepted — 2026-11-03 local

The Resend Keychain item initially trusted `/usr/bin/security`, not the existing `bank-secrets` helper. Normal user-authenticated macOS authorization resolved the mismatch without programmatic ACL changes, all-app access or replacement of trusted binaries. A bounded metadata-only launcher preflight now rejects the known mismatch before password retrieval; two failure checks passed. Three repeated protected Gateway-config child startups passed with all six secrets present and every safe-profile flag false. No HTTP server/worker was started.

**PROVIDER-VERIFIED:** exactly one deliberately constructed non-production message was sent through the configured Resend adapter to the user-approved controlled recipient. Resend returned HTTP 200 and a provider message ID. This proves acceptance of the configured key/sender for that message; delivery and human inbox receipt remain UNVERIFIED. No provider status query, additional send, outbox processing or worker activation occurred. Durable one-attempt evidence is in `/Users/aayushdivase/Desktop/C1RCLE-M2-A5-ONE-EMAIL-20261103`; launcher diagnostics/report are in `/Users/aayushdivase/Desktop/C1RCLE-M2-LAUNCHER-FIX-20261103`. Earlier missing-authorization/binding blockers are historical. A6/A7, Razorpay, hosted staging and Milestone 3 remain outside scope.

## Current A6/A7 disposition — isolated candidate preparation, 2026-11-03

This update supersedes earlier pending A6/A7 topology and stale Razorpay-credential statements; earlier execution records remain historical. The operator reported the prior credentials had been regenerated. The current Test Mode pair was securely bound from Keychain, and the retained read-only provider check returned HTTP 200. No order, payment, capture, refund or payout was created. This is credential-usability evidence, not payment or webhook acceptance.

The approved topology is the single existing Render Gateway. Its assessment and proposed configuration are recorded in [Render reuse](render-staging.md) and [the environment contract](staging-environment-contract.md). Hosted secrets, safe flags, exact candidate deployment and matching webhook configuration still require their separate approvals and verification. Candidate preparation does not authorize any of those actions. The broad Milestone 2 gate remains NOT RUN / BLOCKED; Milestone 3 has not begun.
