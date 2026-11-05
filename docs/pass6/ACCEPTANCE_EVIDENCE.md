# Pass 6 acceptance evidence index

Status date: 2026-11-05. Evidence is local to the isolated Pass 6 candidate and does not establish staging, provider delivery, inbox delivery, or production readiness.

## Candidate and preservation

- Backend Pass 6 branch: `codex/pass6-transactional-email-20261105`
- Backend Pass 6 HEAD: `9228644b398456aa83bee98e6583097070056ce7`
- Frontend Pass 6 branch remains at frozen Frontend #94: `codex/pass6-email-ui-20261105`, `d40700eb79380f05438d4b8390801ba79a353baf`, clean
- Frozen Backend #160 remains `ae767808ba0d10c0f29fd0fb0935c3326a76c0a6`
- Frozen Frontend #94 remains `d40700eb79380f05438d4b8390801ba79a353baf`
- No PR, push, merge, deployment, staging mutation, or Resend send was performed.

## Local test evidence

| Check | Result |
| --- | --- |
| Core transactional email, cancellation, onboarding, Admin authorization, and Firestore delivery recovery tests | 88 passed; Firestore emulator recovery test separately passed (1/1) using `demo-c1rcle-pass6` and only the Firestore emulator |
| API Gateway Resend sender and config tests | 56 passed |
| Core typecheck | Passed |
| API Gateway typecheck | Passed |
| Guest Portal `/tickets` and `/help` route tests | 10 passed after building the locked shared workspace dependencies |
| Changed-file formatting, ESLint, commit hooks, and `git diff --check` | Passed |

The Firestore delivery recovery test proves claim/lease recovery and provider-ID persistence against the loopback Firestore emulator. It passed in this run using the explicit demo project `demo-c1rcle-pass6`; no remote Firebase project was used.

## Rendered preview and visual evidence

- A dedicated founder checkpoint is indexed at [EMAIL_DESIGN_VISUAL_ACCEPTANCE.md](./EMAIL_DESIGN_VISUAL_ACCEPTANCE.md). It contains 38 rendered HTML variants and text alternatives, produced by the actual transactional email consumer using synthetic fixtures and local capture.
- The requested receipt, ticket custody, KYC, refund, event lifecycle variants, plus RSVP, ticket issuance/upgrades, waitlist, promoter operations, event cover/add-ons, payment support, payout outcomes, and refund review renders are preserved under `previews/`.
- Desktop/mobile screenshots have not been captured, and founder visual approval is pending. The browser environment rejected `file://` and explicitly prohibited alternate rendering routes. HTML artifacts are available for external capture and review; no visual approval is implied.

## Provider and runtime boundary

- Presence-only environment check: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_NON_PROD_TEST_RECIPIENT`, and `FIRESTORE_EMULATOR_HOST` were all unconfigured.
- Development/test capture tests prove local capture is distinct from provider acceptance and that non-allowlisted recipients do not reach Resend.
- Provider adapter tests prove a configured test sender, idempotency header, HTML/text payload, provider ID handling, terminal 4xx classification, missing-sender fail-closed behavior, and production no-capture behavior.
- Real provider acceptance remains **HOSTED/PROVIDER ACCEPTANCE REQUIRED**. No Resend-accepted or delivered status is claimed.

## Explicitly unresolved acceptance

1. Founder visual acceptance or explicit waiver, after reviewing the rendered HTML artifacts.
2. Real non-production Resend acceptance using a verified configured sender and founder-controlled allowlisted recipient.

Local implementation and focused test evidence do not satisfy these external/rendering gates by themselves.
