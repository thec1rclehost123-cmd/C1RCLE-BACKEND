# Milestone 2 gate remediation and pending decisions

Inspected 2026-11-03 local / 2026-11-04 UTC. Initial remediation authorized the 14 reviewed index additions, local safety profile, read-only investigations and documentation. Subsequent explicit A2 approval authorized the three signing/HMAC secrets and narrow session/credential invalidation, recorded below. Bank encryption provisioning, Resend retrieval/binding, provider configuration, email, payments/refunds, production changes and broader business-data mutations remain unauthorized. Milestone 2 remains incomplete.

## Workspace and evidence

Backend: `C1RCLE-M4-M5-LINEAGE-BACKEND`, branch `codex/m2-provider-config-readiness`, HEAD `1b4fe343d4e29dd1ada0865b038534fdbdc45b45` plus preserved uncommitted work. Frontend: `C1RCLE-M4-M5-LINEAGE-FRONTEND`, branch `codex/m1-guest-signup-classification`, HEAD `417d4e7d99c5241e63b48508790401faa18be54f` plus preserved uncommitted work. These SHAs alone do not identify the local candidate; start/end source hash manifests record it.

Sanitized evidence is outside the repository in `C1RCLE-M2-GATE-REMEDIATION-20261103`. No secret values, personal bank details or session tokens are included.

## A1: approved index deployment — CONNECTED NON-PRODUCTION VERIFIED

Added exactly the 14 reviewed definitions from the existing manifest to `c1rcle-v2/(default)` through additive Firestore Admin create requests. Compared each definition to both the prior reviewed subset and the current manifest before mutation. No rules deployment, index deletion, IAM change or business-document write occurred.

All 14 reached READY. Deployed composite count changed from 72 to 86; all pre-existing index names remained and no unexpected definition was added. The two previously identified equivalent index merges and two deployed-only stale candidates were preserved.

All 26 previously index-failing affected plans now pass: 12 source-shape plans and 14 exact manifest-shape plans (overlapping coverage, not 26 unique workflows). Used `explain({analyze:false})` with limit 1; no business query execution. This includes the actual promoter assignment-expiry source shape. The 14-index deployment requirement is satisfied; actual expiry processing, worker delivery and broader connected business workflows remain unverified. Workers stayed off.

The first metadata list call rejected an explicit page size before any mutation; removing that unsupported parameter resolved it. Build states and query plans, rather than the creation acknowledgements alone, establish the result.

## A4: approved safe local profile — effective configuration verified

Authoritative local acceptance file: `apps/api-gateway/.env.local`. The Gateway `dev` script explicitly loads that file using `tsx watch --env-file-if-exists=.env.local`; externally supplied process environment can override file values and must be checked for each future launch.

Only these keys were set explicitly to `false` in that ignored, restricted-permission file:

- `PAYOUTS_ENABLED`
- `BACKGROUND_WORKERS_ENABLED`
- `M5_PRIVATE_ACCESS_ENABLED`
- `M5_ELIGIBILITY_RULES_ENABLED`
- `M5_TICKET_TRANSFERS_ENABLED`
- `M5_OFFLINE_TICKET_MANIFESTS_ENABLED`
- `M5_OFFLINE_MANIFEST_DRAIN_COMPLETE`
- `M5_COVER_SALES_ENABLED`
- `M5_TICKET_ADDONS_ENABLED`
- `M5_COVER_MERCHANT_APPROVED`
- `M5_COVER_ACTIVATION_APPROVED`
- `M5_COVER_ACCOUNTING_APPROVED`

Verified effective parsing and the actual payout-gate helper: all false, project `c1rcle-v2`, driver Firestore. Unrelated environment lines and private file permissions were preserved; no secret was changed. No Gateway was started/restarted, so this is a verified future-launch profile, not proof that any already-running external process changed configuration. A bounded listener check found no local TCP listener on port 8080 at verification time; other ports/remote processes were not asserted stopped.

## A2: approved secret provisioning and session revocation

Pre-rotation snapshot: Better Auth used the published development default; OTP and ticket master secrets were absent and resolved published fallbacks. Do not use these for connected acceptance. Each replacement must be independent, generated with a cryptographically secure RNG: recommend 32 random bytes encoded as 64 hex characters (256 bits), satisfying the current minimum 32-character schema. Do not use human passwords, repeated strings, provider API keys or shared environment keys.

| Runtime variable      | Purpose                                                                                                                   | Rotation effect and limitations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`  | Better Auth cookie/token signatures and library encryption                                                                | Old signed cookies/tokens fail validation. However, the installed bearer plugin is configured without `requireSignature` and accepts raw database session tokens by signing them internally with the current key. Changing this secret alone does not revoke every stored session. Explicit authorized session revocation is required for complete invalidation. Password hashes/account records are separate and must be preserved. Any library-encrypted reset/verification or account material needs inventory before rotation; no broad claim that all credentials survive is justified. |
| `EMAIL_OTP_SECRET`    | HMAC-SHA256 of outstanding email OTP codes                                                                                | Pending codes hashed with the previous key will not match under the new key. OTPs expire after ten minutes; stop issuance/verification during the transition and allow that window to expire, or separately approve explicit invalidation. Already-persisted account verification is not undone by replacing this key. New OTP issuance still requires a configured email sender.                                                                                                                                                                                                            |
| `MAGIC_TICKET_SECRET` | Ticket keys/rotating QR signatures, offline manifest key derivation, scanner confirmations and cover-wallet QR signatures | Previously issued rotating QRs and derived signatures cease matching the new server key; ticket/order ownership records are not deleted. Guest clients must obtain fresh credentials through supported flows. Cached offline manifests/per-ticket keys can remain usable by offline devices until expiry/drain; a server rotation alone does not remotely erase those caches. Offline issuance stays disabled and drain attestation stays false. Do not rotate during admission or claim old offline credentials invalidated without device/drain evidence.                                  |

Source: Gateway auth builder and installed Better Auth bearer/cookie implementation; Core `email-otp` model; door `offline-ticket-crypto`, scanner and cover-wallet services. These are SOURCE-TRACED effects, not an executed rotation or connected invalidation test.

### Secure storage and safest order

1. Confirm that the selected environment is only the approved `c1rcle-v2` acceptance environment. Inventory active test sessions, outstanding OTPs, event/admission windows and offline scanners without exporting tokens or personal records. Confirm which test credentials must remain usable.
2. Obtain explicit approval for invalidating non-production sessions/credentials. Non-production status alone does not establish that disruption is safe; existing acceptance assets may depend on them. No account, booking or ticket deletion is necessary or approved.
3. After approval, prepare separate secret entries in an approved credential store. Suggested non-secret labels: `C1RCLE/non-production/c1rcle-v2/BETTER_AUTH_SECRET`, `C1RCLE/non-production/c1rcle-v2/EMAIL_OTP_SECRET` and `C1RCLE/non-production/c1rcle-v2/MAGIC_TICKET_SECRET`; these were proposed labels at preparation time; the executed Keychain service/account mapping is recorded below. For local use, recommend the OS credential manager/approved existing secret source injecting server process variables; no existing credential-store launcher has been proven configured. Node's env-file loading permits operator-provided process variables to take precedence. For future approved Render acceptance, inject into the protected environment of the existing Gateway only after separate approval, never a frontend or `NEXT_PUBLIC_*`/`EXPO_PUBLIC_*` variables. At preparation time the store IDs/access policy were pending; the actual approved local Keychain mapping is recorded below. No hosted secret store was created.
4. Pause the acceptance runtime and all replicas in a separately approved maintenance window; workers/payouts/provisional flags remain off. Verify non-email reauthentication/recovery is available before invalidating sessions, because current Resend runtime binding is missing.
5. After approval, explicitly revoke affected server sessions through an audited supported procedure. Do not rely on secret rotation alone or directly delete Firestore records as an improvised workaround. Wait out outstanding OTP expiry with issuance stopped. Inventory/quiesce offline credentials before QR-key change; preserve false drain attestation if unproven.
6. After approval, provision the three independent entries and inject them consistently into every acceptance Gateway instance in one coordinated restart. Do not run mixed signing keys or reuse production values. Preserve encrypted-account material separately; this procedure does not rotate bank keys.
7. Validate only names/presence, non-default/strength classification and safe flags. Then perform separately authorized controlled reauthentication/OTP/QR acceptance and explicit rejection checks for previous credentials. Do not count format checks as entropy proof or live invalidation proof.
8. Record non-secret key version references, affected sessions/credential classes, restart and verification outcomes. Back up access securely. Rolling back a compromised/default signing key re-enables risk and is not an acceptable automatic rollback; use forward repair. No old/new secret values go in logs, Git or reports.

The procedure above was subsequently explicitly approved and executed for the current local acceptance runtime, as recorded below. Connected password sign-in, delivered OTP acceptance and the complete Guest/Scanner route workflow remain separately unverified; do not label these passed from cryptographic tests.

### A2 execution record — 2026-11-03 local / 2026-11-04 UTC

User explicitly approved the three independent signing/HMAC secrets, forced non-production reauthentication, session revocation and narrowly required credential invalidation; A3/A5/provider/commercial mutations remain unauthorized.

**Protected storage/runtime binding:** macOS user login Keychain at `/Users/aayushdivase/Library/Keychains/login.keychain-db`, generic-password service `C1RCLE/non-production/c1rcle-v2`, accounts `BETTER_AUTH_SECRET`, `EMAIL_OTP_SECRET`, `MAGIC_TICKET_SECRET`. Each value was generated with Security.framework `SecRandomCopyBytes` from 32 independent random bytes, encoded as 64 hex characters, and stored through `SecItemAdd`. No value was emitted, committed, written into `.env.local`, passed on a command line or copied into reports. Metadata-only inspection and masked runtime parsing confirm presence, format and distinct values.

A protected compiled launcher reads the items with Security.framework, injects them only into the approved child process environment, and forces project `c1rcle-v2`, Firestore/development mode and all twelve safety flags false. Local operations/launcher directory is `/Users/aayushdivase/Desktop/C1RCLE-M2-A2-ROTATION-20261103` (mode 0700); `acceptance-secrets` and `launch-gateway.sh` are executable only by the owner. `launch-gateway.sh` is prepared but **has not been run**. No Gateway was started or hosted deployment/secret binding modified. Use that protected launch path for subsequent acceptance; bare `pnpm dev` does not retrieve these Keychain items and still must not be used with old fallback configuration. Do not recompile/replace the trusted launcher casually or export the values into diagnostics.

**Explicit revocation:** inventory contained 818 stored Better Auth sessions, 126 unexpired. Revoked all 818 through the installed Better Auth session lifecycle (`internalAdapter.deleteSessions`), not improvised Firestore deletion. The final collection count was zero and remained zero on an independent later read. Five sampled real raw bearer tokens resolved before revocation, including under the new signer; all five failed afterward under both new and old signers. This is CONNECTED NON-PRODUCTION VERIFIED session revocation. No session tokens were persisted in evidence.

The initially constructed connected cookie samples did not have a valid baseline (0/5), so they are excluded from connected rejection proof. A separate isolated test using the library's actual cookie serializer proves a valid old signed cookie is rejected by the new signer. Do not turn the unsuccessful connected-cookie construction into a passed acceptance claim.

**Accounts/commercial preservation:** before/after aggregate hashes match for `v2_auth_users`, `v2_auth_accounts`, `v2_organizations` (including embedded memberships), `v2_orders`, `v2_entitlements`, `v2_scan_ledger`, `v2_events`, `v2_email_otps`, `v2_scanner_sessions`, `v2_scanner_devices` and `v2_event_codes`. All 117 users/accounts remain; all 117 auth accounts are password-provider accounts and none contains provider-token material. No password, role, membership, order, ticket, admission, bank or provider record was changed. No pending Better Auth verification-token records were found.

**OTP effects:** both existing OTP records were already expired; zero outstanding unexpired codes required mutation. They were preserved. With the provisioned HMAC key, a newly generated in-memory code passes the real OTP model and the old key fails validation. No email sender, connected OTP issuance or account-verification write was invoked. Delivered OTP/signup verification remains BLOCKED because Resend retrieval/binding and email sending were not approved.

**Ticket effects:** regenerated and validated signed QR payloads in memory using the actual cryptographic functions and IDs/credential versions read from all 28 eligible existing entitlements. All 28 new-key signatures validate and all 28 old-key signatures fail against the new key. No ticket/ownership/version/scan-history record changed; signature regeneration needs no ticket recreation. This is connected-read plus FOCUSED TESTED cryptography, not end-to-end authenticated Guest wallet or Scanner admission acceptance. No actual scan/admission call was made. The legacy bare-ID compatibility path is unchanged and is not claimed invalidated by signing-key rotation.

There were zero active scanner sessions. All 43 stored scanner-session expiries were well beyond both the 12-hour manifest TTL and its 24-hour additional sync grace at inspection, with no malformed expiry. This supports the expiry bound for normally issued manifests; no device cache was physically/remotely inspected or erased. Offline issuance stays off and drain attestation stays false. Do not claim physical offline-device cleanup.

**Fresh authentication:** the installed Better Auth library, provisioned secret and isolated memory adapter pass fresh email/password sign-in, authenticated lookup, correct old-cookie rejection and explicit session revocation. No real account was created, impersonated, reset or given a replacement password. Fresh connected password sign-in is BLOCKED pending an approved controlled test identity/password supplied through a protected mechanism, never chat. No hosted runtime was inspected/configured; other deployments must not be assumed to share the new local binding.

**Focused checks:** 40 repository cases passed (35 OTP/QR model/service cases and five selected Gateway auth cases), plus the protected-key behavioral checks above. One conditional session-security Emulator case was skipped because no Emulator was running; seven other auth cases were deliberately deselected. None is counted as passing or as resolution of the existing 63 M1 skip dispositions. The initial isolated fixture failed because the memory adapter model arrays were absent; after correcting only that fixture, the real library flow passed. No application/contract source changed, full suite, broad gate, build or provider call ran.

Evidence outside Git: `C1RCLE-M2-A2-ROTATION-20261103/REPORT.md`, `inventory.json`, `rotation-result.json`, `auth-check.json`, `final-read.json`, sanitized progress and focused-test logs. The remaining A3/A5/topology/connected-acceptance requirements still block the Milestone 2 broad gate.

## A3: bank encryption read-only investigation

CONNECTED NON-PRODUCTION VERIFIED: an aggregate count of the exact current Core repository collection `c1rcle-v2/v2_bank_accounts` returned **zero records**. No bank documents or plaintext account numbers were read; no data was added/changed. This does not establish absence in legacy collections, backups or other environments, which were not inspected.

SOURCE-TRACED: the current runtime has neither `ENCRYPTION_KEY` nor `ENCRYPTION_SALT`, so it resolves the published legacy pair. AES-256-GCM envelopes contain IV, tag and ciphertext, but no key/salt version. The derived key depends on both secret and salt; organization ID is authenticated additional data. Keep all three associations intact.

The bank service tries the configured pair, then the fixed legacy pair. Thus legacy-default ciphertext can remain readable after a properly configured new key, but arbitrary earlier custom keys/salts are not retained. Replacing a custom pair can strand existing ciphertext. No existing ciphertext exists in the inspected collection to validate the fallback against connected records.

Before any change: approve the stable key and salt together; securely back up their version/provenance and access policy; confirm whether any legacy/imported records will be brought into this namespace; establish a recovery test on synthetic data and an approved migration/key-version plan if existing custom ciphertext appears. Future new encrypted records require keeping their originating pair available. Zero current records does not authorize provisioning. No encryption material or data migration was performed.

## A5: Resend existing provider — READ-ONLY TRACE

**Provider/domain previously operational; current inspected Gateway runtime binding missing or unverified.** The operator manually verified the active account, VERIFIED `thec1rcle.com`, existing `Onboarding` Sending access key, recent use and prior Delivered messages. Those are user-provided provider facts, not independently rechecked dashboard evidence.

Repository trace: the adapter receives `GatewayConfig.RESEND_API_KEY` from `v2-services.ts` and uses Resend's HTTP API. `render.yaml` declares the secret `sync:false` and documents that its value lives in Render's protected runtime environment. This proves the intended injection path, not the actual current production or staging value. No production dashboard or runtime was accessed.

Current authoritative and prior M3 local Gateway `.env.local` files have no binding; the directly inspected legacy Gateway development file has none. Two older nested development/staging files timed out in bounded read-only attempts and were not recovered. No key was used, revealed, copied, hashed into reports or placed into the new environment. A metadata-only Secret Manager list in `c1rcle-v2` was blocked because that API is disabled. This does not prove that no secret exists elsewhere; no service was enabled, version accessed or IAM changed.

Correct current location: server-only `RESEND_API_KEY` injected into the approved local Gateway process from an approved protected store. A future dedicated non-production Render Gateway uses its protected Environment/secret binding; never put it in Vercel public variables or reuse the production service. The sender currently remains `noreply@thec1rcle.com`. No separate Resend SMTP password, domain ID or webhook signing secret is required by the inspected sending adapter.

The dashboard normally does not reveal an old API secret again. The existing named key cannot be safely recovered from the inspected local bindings; secure custody elsewhere remains unverified. The next decision is an operator-controlled secure retrieval/reuse from its existing approved store, if available, with scope/consumer review. Otherwise recommend a separately approved dedicated non-production Sending access key restricted to the verified domain, provision it directly to the approved store, verify it, and only later consider revocation of an older key after accounting for all consumers. Do not automatically replace/revoke the operational `Onboarding` key.

No new account/domain/key, DNS edit, provider change or email was made. Do not re-add the already-verified domain. Safe later verification: read-only binding/permissions evidence, then an approved namespaced provider test-recipient send, then separately approved controlled inbox receipt. Test-recipient simulated delivery, API acceptance, outbox records and real inbox receipt are different evidence levels. Keep workers off to avoid draining unrelated outbox records.

Official references: [API key confidentiality](https://resend.com/docs/dashboard/api-keys/introduction), [Sending access/domain restriction](https://resend.com/changelog/new-api-key-permissions), [test recipients](https://resend.com/docs/dashboard/emails/send-test-emails). These references do not establish this account's current runtime binding.

## A6: Razorpay read-only configuration

The current local set is structurally complete: Test Mode key-ID shape, secret present, webhook secret present and not the published memory-provider fallback. No credential validity call, payment, refund or dashboard request occurred. Format/presence is not provider verification.

The source receiver is `POST /api/v2/webhooks/payments/razorpay`; the intended staging URL is `https://<approved-non-production-edge>/api/v2/webhooks/payments/razorpay`. No exact existing non-production HTTPS hostname is established; current public API/Auth/Partner origins are localhost HTTP. Never substitute the live backend hostname merely because an example contains it.

Source-supported subscriptions to review in Test Mode: `payment.captured`, `refund.processed`, `payment.dispute.created`, `payment.dispute.action_required`, `payment.dispute.under_review`, `payment.dispute.won`, `payment.dispute.lost`, `payment.dispute.closed`. The receiver verifies `x-razorpay-signature` using HMAC-SHA256 over the raw request body and `RAZORPAY_WEBHOOK_SECRET`, before service work. The API key secret is a separate credential; do not substitute it for the webhook secret.

Dashboard receiver, enabled subscriptions, matching secret binding, provider account identity and real delivery remain UNVERIFIED. Later authorized Test Mode acceptance must prove capture/order correlation, duplicate/order handling, durable provider facts and fulfillment/refund recovery as assigned to Milestone 4. Source records refund/dispute facts; subscription support alone is not complete financial-lifecycle acceptance.

## A7: existing Gateway reuse — supersedes the initial split-service proposal

The initial two-service staging recommendation was rejected by the operator. Do not create a private Gateway, public edge or paid sidecar. Reuse the existing `circle-v2-backend` Render service and its in-container Nginx/Fastify topology only after separate configuration and deployment approval. See [the reviewed single-service plan](render-staging.md) and [acceptance environment contract](staging-environment-contract.md). No hosted change has been executed as part of candidate preparation.

## A8 and gate disposition

Historical Firestore startup-timeout root cause remains **UNVERIFIED**. Current readiness improvements or passing samples do not reconstruct the missing historical trace.

The M1 gate's **63 remaining skipped/unverified cases** retain their dispositions: four connected Firestore adapter cases requiring mutation approval and 59 conditional later-domain Emulator cases. No skip became a pass in this remediation. Deliberate focused-test deselection is a separate category.

The broad Milestone 2 gate is **NOT RUN / BLOCKED**: unverified connected authentication/OTP/Scanner acceptance, missing bank key, missing current Resend binding, unverified Razorpay webhook/provider configuration and unresolved hosted topology prevent a meaningful passing readiness gate. Running broad mocked suites would not close those mandatory evidence gaps. The authorized focused checks and index plans are reported separately. No acceptance criterion was weakened, and Milestone 3 has not begun.

Stop for approval before any further secret provisioning/rotation, retrieving/injecting a provider key, changing DNS/providers, sending email, payments/refunds, encryption changes, infrastructure, production, Git publication or Milestone 3.

## A3 + A5 bounded configuration execution — 2026-11-03 local

Subsequent explicit approval authorized bank key/salt provisioning and reuse of an existing approved protected Resend secret only. This record supersedes the earlier pending-authorization/current-binding statements above for this local runtime; historical evidence remains historical.

**A3 — FOCUSED TESTED, configured local runtime:** a fresh read-only aggregate confirmed `c1rcle-v2/v2_bank_accounts` contains zero records. Two independent 32-byte CSPRNG values were stored as `ENCRYPTION_KEY` and `ENCRYPTION_SALT` under macOS login Keychain generic-password service `C1RCLE/non-production/c1rcle-v2`. Values and fingerprints were never emitted or written to ordinary environment files. Preserve the pair together; no independent rotation or migration is authorized.

The protected launcher is `/Users/aayushdivase/Desktop/C1RCLE-M2-A2-ROTATION-20261103/launch-gateway.sh`. It now chains the protected bank helper in `C1RCLE-M2-A3-A5-CONFIG-20261103` into the existing trusted A2 helper and pinned Node executable. Both helpers enforce the non-production profile. The A2 binary was not replaced. Bare `pnpm dev` does not retrieve these Keychain values and is not the approved configured acceptance startup.

Separate fresh child processes loaded the actual Gateway config using `.env.local` plus Keychain injection. Synthetic-only bank-service writes used an in-memory repository. Encryption/decryption, random IVs, process-reload consistency, wrong-key/salt/context rejection and the current route's masked DTO serialization passed. The configured Core pair matches injected Gateway values and differs from the published defaults; legacy defaults cannot decrypt new synthetic ciphertext. Existing legacy read compatibility remains unchanged. No other source encryption writer was found beyond the bank-account service; legacy collections/backups/environments were not exhaustively inspected. No connected bank record, commercial mutation or migration occurred. The Gateway HTTP server was not started; runtime proof is protected child config/service execution, not hosted acceptance.

**A5 — BLOCKED:** the approved non-production Keychain namespace has no `RESEND_API_KEY`; the effective protected local config also has none. Prior sanitized custody evidence found no key in the inspected local bindings; Secret Manager metadata listing was API-disabled, and Render source points to protected dashboard injection without proving a reusable non-production secret. Production custody was not accessed. No secret was recovered, copied or bound, and no key was created/revoked. A credential-less adapter constructs successfully without network access; all inspected senders are `noreply@thec1rcle.com`. The user's verified `thec1rcle.com` domain is compatible with that address; actual key permissions/provider status were not independently verified here.

The missing action is controlled retrieval from an approved protected source into this non-production binding. If none is recoverable, a dedicated Sending-access non-production key restricted to the verified domain is recommended, requiring separate approval to create/provision. Do not revoke `Onboarding`. Actual email receipt requires a later separately approved controlled send. No send method, outbox drain, provider/dashboard/DNS change or webhook action ran.

Focused evidence: 30 selected Core bank/encryption tests and seven selected Gateway bank-route tests passed; 45 unrelated cases were deselected, not claimed as passed. Synthetic reload and exact-value evidence leakage scans passed. No TypeScript source/contracts changed, so package typechecks were not rerun for this configuration-only pass. Swift compilation and shell syntax checks cover the launcher changes. Evidence is outside Git in `/Users/aayushdivase/Desktop/C1RCLE-M2-A3-A5-CONFIG-20261103`. Workers, payouts, offline/provisional features and drain attestation remain false. Milestone 2 broad gate was not run; HTTPS Gateway/Razorpay and Milestone 3 have not begun.

## A5 protected local binding completed — 2026-11-03 local

Following the operator's secure provisioning and explicit binding approval, the existing protected helper successfully read `RESEND_API_KEY` from macOS login Keychain service `C1RCLE/non-production/c1rcle-v2`, account `RESEND_API_KEY`. The existing bank-helper → A2-helper → pinned Node launcher chain already supports this entry; no helper source/binary replacement or ordinary `.env.local` edit was needed. The operator identifies this as a new dedicated non-production Sending key. No key was created, revoked or changed by this pass; `Onboarding` was untouched.

**FOCUSED TESTED:** a fresh protected child loaded the actual Gateway config, recognized the nonempty key and initialized `ResendEmailSender` with that same configured value. Source wiring passes `gwConfig.RESEND_API_KEY` to this adapter. All inspected sender addresses remain `noreply@thec1rcle.com`; compatibility with the verified domain rests on the operator's domain verification evidence. No provider permissions, key validity or delivery claim is inferred from construction/presence.

Workers/payouts/offline/provisional flags and drain attestation were false. No HTTP server, send method, provider request, outbox drain or connected data mutation ran. Network sending was explicitly blocked in the runtime diagnostic. Both complete focused files (`src/config/index.test.ts`, `src/lib/notifications/resend-email-sender.test.ts`) passed: 30 tests, no skips. Adapter send behavior in those tests uses synthetic credentials and mocked fetch only, never the Keychain credential. The initial exact-value scan found zero secret matches across 929 repository/evidence/config files; final scan follows documentation updates. No secret values or fingerprints are recorded.

A5's local binding blocker is closed. Actual provider credential acceptance and email receipt remain UNVERIFIED and require a separately approved controlled send: agree the controlled recipient, one namespaced message and sender, and inspect sanitized provider outcome/receipt. Keep workers OFF and do not drain persisted outbox work to test delivery. No new key is required for this binding. A6/A7, hosted staging, Razorpay and the broad Milestone 2 gate remain outside this pass.

Evidence: `/Users/aayushdivase/Desktop/C1RCLE-M2-A5-BINDING-20261103/runtime-result.json`, `focused-tests.log` and this report. These configured child-process checks are not running-hosted-Gateway or provider-delivery acceptance.

## Launcher authorization resolved; one Resend message accepted — 2026-11-03 local

The Resend Keychain item initially trusted `/usr/bin/security`, not the existing `bank-secrets` helper. Normal user-authenticated macOS authorization resolved the mismatch without programmatic ACL changes, all-app access or replacement of trusted binaries. A bounded metadata-only launcher preflight now rejects the known mismatch before password retrieval; two failure checks passed. Three repeated protected Gateway-config child startups passed with all six secrets present and every safe-profile flag false. No HTTP server/worker was started.

**PROVIDER-VERIFIED:** exactly one deliberately constructed non-production message was sent through the configured Resend adapter to the user-approved controlled recipient. Resend returned HTTP 200 and a provider message ID. This proves acceptance of the configured key/sender for that message; delivery and human inbox receipt remain UNVERIFIED. No provider status query, additional send, outbox processing or worker activation occurred. Durable one-attempt evidence is in `/Users/aayushdivase/Desktop/C1RCLE-M2-A5-ONE-EMAIL-20261103`; launcher diagnostics/report are in `/Users/aayushdivase/Desktop/C1RCLE-M2-LAUNCHER-FIX-20261103`. Earlier missing-authorization/binding blockers are historical. A6/A7, Razorpay, hosted staging and Milestone 3 remain outside scope.

## Current A6/A7 disposition — isolated candidate preparation, 2026-11-03

This update supersedes earlier pending A6/A7 topology and stale Razorpay-credential statements; earlier execution records remain historical. The operator reported the prior credentials had been regenerated. The current Test Mode pair was securely bound from Keychain, and the retained read-only provider check returned HTTP 200. No order, payment, capture, refund or payout was created. This is credential-usability evidence, not payment or webhook acceptance.

The approved topology is the single existing Render Gateway. Its assessment and proposed configuration are recorded in [Render reuse](render-staging.md) and [the environment contract](staging-environment-contract.md). Hosted secrets, safe flags, exact candidate deployment and matching webhook configuration still require their separate approvals and verification. Candidate preparation does not authorize any of those actions. The broad Milestone 2 gate remains NOT RUN / BLOCKED; Milestone 3 has not begun.
