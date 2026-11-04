# Firestore index and rules evidence — Packet 2.4

Evidence date: 2026-11-03. Approved non-production project: `c1rcle-v2`, database `(default)`. Backend checkpoint `1b4fe343d4e29dd1ada0865b038534fdbdc45b45` plus local uncommitted work, branch `codex/m2-firestore-index-rules-evidence`. This is an evidence audit, not a deployment or launch acceptance claim.

## Deployed coverage

| Classification                         | Count | Evidence                                                                                                                  |
| -------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| Present, exact local definition        | 70    | Firebase CLI and Firestore Admin API listings agree; all deployed indexes READY                                           |
| Equivalent coverage                    | 2     | Plan-only Query Explain confirms single-field index merges for entitlement user/event and order event/Promoter equalities |
| Missing deployed coverage              | 14    | No exact definition and corresponding planner query returns FAILED_PRECONDITION, code 9                                   |
| Deployed-only, unused/stale candidates | 2     | Singular Scanner collection and ascending journal order differ from current source; no deletion performed                 |
| Local manifest                         | 86    | Existing definitions, unchanged                                                                                           |
| Deployed composites                    | 72    | 70 exact matches plus two deployed-only candidates                                                                        |

The 70 present definitions are a deployment comparison, not a claim that every definition is required by the launch scope. Unused conditional definitions must not be deleted based solely on this audit. Two equality-only local definitions are redundant for the tested query shapes because merged single-field indexes already serve them; they were preserved.

Source tracing covered repository query construction in `packages/core/src/infrastructure/firestore`, pagination helpers, runtime client initialization and Gateway-owned Firestore auth. A diagnostic extraction resolved 62 distinct composite-requiring source shapes. Plan-only explanations passed for 50 and reported missing indexes for 12. Sixteen further explanations checked exact-missing manifest definitions, including optional filter combinations and the two equality-only alternatives. Total: 78 planner requests, 52 successful and 26 failed across overlapping groups; this is not 78 distinct application workflows.

The checked-in guard passes 63 heuristic records. Its class-level collection ambiguity accounts for one duplicate compared with the diagnostic's 62 resolved shapes. It does not validate deployed state, all dynamic filter branches, collection scope, array modes or sort directions. Equality-only shapes and optional branches were examined separately where relevant. Neither this guard nor a successful planner response is an exhaustive route/authorization/transaction test. A complete 358-route audit was not repeated.

[Query Explain documentation](https://firebase.google.com/docs/firestore/query-explain) distinguishes plan-only explanations from execution. Every explanation here used `analyze: false`, synthetic filter values and `limit(1)`; no business documents were returned. Plan-only explanations still incur one read charge each. Query plans, not timing, establish coverage here.

### Consumer relevance

| Surface               | Representative repository paths                                                   | Index finding                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Guest                 | Public event discovery; user/event entitlement and order lookups                  | Discovery source plan passes; two equality-only alternatives verified by merged indexes; wallet behavior is separate acceptance work |
| Host / Venue          | Organization recent orders, partnerships, invitations, Promoter assignment expiry | Inspected recent-order/network plans pass; assignment expiry is blocked by its missing deployed index                                |
| Promoter              | Event attribution order filter, assignments, social notifications                 | Equality-only order attribution has merged coverage; assignment expiry and notification plans have gaps                              |
| Admin                 | Onboarding/refund/support ordered listings, financial journal listing             | Inspected onboarding/refund/support plans pass; descending organization journal plan fails                                           |
| Scanner               | Device organization listing, sessions, scan ledger queries                        | Device listing fails; inspected session/ledger plans pass; admission transaction/permissions are separate workflow acceptance        |
| Workers / deferred M5 | Outbox, transfer expiry, waitlists, cover challenges                              | Outbox plans pass; expiry/waitlist/cover-challenge gaps recorded; no worker or feature enabled                                       |

### Missing definitions already present locally

All scopes below are `COLLECTION`. Arrows mean ascending/descending sort, not deployment order.

| Collection                              | Fields                                                      | Classification                                     |
| --------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| `v2_event_cover_redemption_challenges`  | `status` ↑, `expiresAt` ↑                                   | Missing deployed coverage; local definition exists |
| `v2_waitlist_entries`                   | `status` ↑, `offerExpiresAt` ↑                              | Missing deployed coverage; local definition exists |
| `v2_follows`                            | `followerId` ↑, `createdAt` ↓                               | Missing deployed coverage; local definition exists |
| `v2_follows`                            | `followerId` ↑, `targetType` ↑, `createdAt` ↓               | Missing deployed coverage; local definition exists |
| `v2_follows`                            | `targetType` ↑, `targetId` ↑, `createdAt` ↓                 | Missing deployed coverage; local definition exists |
| `v2_social_notifications`               | `eventChange.entitlementId` ↑, `eventChange.eventVersion` ↓ | Missing deployed coverage; local definition exists |
| `v2_social_notifications`               | `userId` ↑, `createdAt` ↓                                   | Missing deployed coverage; local definition exists |
| `v2_social_notifications`               | `userId` ↑, `readAt` ↑, `createdAt` ↓                       | Missing deployed coverage; local definition exists |
| `v2_scanner_devices`                    | `organizationId` ↑, `lastSeenAt` ↓                          | Missing deployed coverage; local definition exists |
| `v2_financial_journals`                 | `organizationId` ↑, `postedAt` ↓                            | Missing deployed coverage; local definition exists |
| `v2_event_catalog_promoter_assignments` | `status` ↑, `expiresAt` ↑                                   | Missing deployed coverage; local definition exists |
| `v2_waitlist_entries`                   | `eventId` ↑, `tierId` ↑, `sequence` ↑                       | Missing deployed coverage; local definition exists |
| `v2_waitlist_entries`                   | `eventId` ↑, `tierId` ↑, `status` ↑, `sequence` ↑           | Missing deployed coverage; local definition exists |
| `v2_ticket_transfers`                   | `status` ↑, `expiresAt` ↑                                   | Missing deployed coverage; local definition exists |

Do not append duplicate definitions locally. A concrete 14-definition review artifact is retained outside the repository as `C1RCLE-M2-PACKET-2.4-20261103/missing-deployed-indexes.json`. Deployment requires separate approval and subsequent READY/plan verification; no deployment command ran. This artifact is not a replacement for the full repository manifest.

### Equivalent equality-only shapes

- `v2_entitlements`: `userId == syntheticUser`, `eventId == syntheticEvent`. Planner uses `(userId ASC, __name__ ASC)` and `(eventId ASC, __name__ ASC)`.
- `v2_orders`: `eventId == syntheticEvent`, `attribution.promoterId == syntheticPromoter`. Planner uses the corresponding two single-field indexes.

The extra deployed journal index is `(organizationId ASC, postedAt ASC)`; it does not serve the source's descending journal query (confirmed code 9). The extra deployed Scanner index targets `v2_scanner_device`, while source uses plural `v2_scanner_devices` (confirmed code 9). These are unused/stale candidates relative to inspected current source, not authorized deletions; other deployment consumers were not exhaustively proven absent.

## Promoter assignment expiry

`FirestoreEventCatalogRepository.listExpiredAssignments` constructs:

```text
collection('v2_event_catalog_promoter_assignments')
  .where('status', 'in', ['invited', 'accepted', 'active'])
  .where('expiresAt', '<=', now.toISOString())
  .orderBy('expiresAt', 'asc')
  .limit(clamp(limit, 1, 100))
```

Required index: `status ASC, expiresAt ASC`, scope `COLLECTION`. It already exists in `firestore.indexes.json` but is absent from the deployed listing; the exact source shape fails planning with code 9. The warning prevents the worker from retrieving due assignments, so persisted expiry/notifications cannot be claimed operational. Any use-time expiry checks do not replace this sweep. Workers were never enabled during the audit.

## Rules and IAM

`firebase.json` points to the checked-in index manifest and `firestore.rules`. The deployed `cloud.firestore` release and its ruleset were fetched with the existing configured Gateway service account. The deployed source is byte-identical to local deny-all client rules, SHA-256 `535be4fe735da33c998820d9190624031e76c0ec17749e78f79e691cc9e9bb33`. Release update time is `2026-09-21T09:23:47.628479Z`; this is observed existing deployment metadata, not a deployment performed here.

The first operator-token request failed because its ADC context lacked a quota project. Adding a quota-project header with the runtime identity was denied for `serviceusage.services.use`. Using the existing service-account request without that unnecessary header succeeded. No credentials, roles, quotas, API enablement or billing settings were changed.

The local rules deny every client read/write. Guest, Partner, Admin and Scanner source inspected here accesses Firestore through the Gateway, not a frontend Firestore SDK. The Core infrastructure initializes the Admin SDK with the configured service account. Admin SDK authorization depends on IAM and server-side identity/organization/Core checks; client rules do not enforce those server checks. Better Auth's Firestore adapter also uses that privileged connection. No claim of security is derived merely from deny-all rules.

Read-only `testIamPermissions` for the configured service account returned entity get/list/create/update/delete, database get, index list, and rules release/ruleset get among the requested permissions. It did not return requested index create/delete or project-policy-read permissions. The existing operator could inspect project policy; the runtime principal has unconditional `roles/firebase.sdkAdminServiceAgent`, `roles/firebaseauth.admin`, `roles/iam.serviceAccountTokenCreator` and `roles/storage.admin` bindings. This is evidence of current authority, not proof of least privilege. Inherited policy, resource-specific conditions and actual connected writes were not exercised. Broader least-privilege review belongs to Packet 5.6; no IAM change is authorized by this packet.

## Narrow verification

- Local index guard passed: 63 heuristic records covered by the manifest.
- Eight Emulator assertions passed on an owned loopback `c1rcle-v2` process: Admin create/read of a synthetic fixture; anonymous GET/PATCH/DELETE denied; emulator-authenticated GET/PATCH/DELETE denied; actual expiry repository query selects due invited/accepted/active assignments and excludes cancelled/future fixtures.
- Fixture records were deleted and the owned Emulator stopped; ports 8185/9155 released. No existing runtime was stopped.
- Emulator composite-index enforcement is not production-equivalent. The expiry assertion proves query semantics, not deployed coverage. Deployed planner failures are the index evidence.
- No application/contract/index/rules source changed, so package typechecks and application suites were not rerun. Documentation was reviewed and `git diff --check` passed. No full suites, builds, load tests or provider actions ran.

Evidence files (outside repository): `live-indexes.json`, `live-indexes-admin.json`, `index-classification.json`, `source-query-classification.md`, `query-explain.json`, `deployed-rules-runtime-no-quota.json`, `runtime-iam.json`, `emulator-result.json` and source-preservation manifests in `C1RCLE-M2-PACKET-2.4-20261103`.

Packet investigation is complete; deployment remediation remains blocked on separate authorization. Preserve the prior Packet 2.3 historical-timeout uncertainty. Stop before Packet 2.5.

## Subsequent approved remediation

The absent-index findings above are historical Packet 2.4 evidence. Under later explicit A1 authorization, exactly the 14 reviewed definitions were added to `c1rcle-v2`; all reached READY, deployed count changed from 72 to 86, and no pre-existing index was removed. All 26 previously failing affected plans now pass with `analyze:false`, including promoter assignment expiry. See [current remediation evidence](milestone-2-remediation.md). The index requirement is now satisfied; actual worker expiry processing is not established and workers remain off. No rule/IAM/business-data change occurred.
