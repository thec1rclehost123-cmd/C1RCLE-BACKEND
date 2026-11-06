# Hosted Promoter agreements

No production agreement has been founder-approved. Leave PROMOTER_AGREEMENT_ARTIFACT unset in production: campaign eligibility and attribution remain unavailable.

The trusted server configuration accepts DEPLOYMENT_ENVIRONMENT (production by default, staging, or local) and an optional PROMOTER_AGREEMENT_ARTIFACT JSON object containing version, status, text, and textSha256. The SHA-256 must match the exact UTF-8 text and the version must end in a hyphen followed by that full 64-character hash; preserve whitespace when publishing. Binding the version to the complete hash prevents an applicant from accepting different content after viewing an earlier document with the same version. Invalid configured artifacts stop service initialization. These variables do not depend on NODE_ENV: staging may still run NODE_ENV=production.

Production accepts only status approved. A staging_only artifact requires DEPLOYMENT_ENVIRONMENT=staging, a staging- version, the explicit staging heading, and the known staging Render service ID, Firestore project, and canonical API/auth origins. The Render service identity is checked independently of the deployment-environment flag. test_fixture cannot be configured through this mechanism; its existing memory/emulator restriction is unchanged. Staging acceptance cannot satisfy production checks because artifact status, version, content hash and accepting user must all match.

For a separately authorized staging deployment, use the complete JSON in promoter-agreement-staging.json as PROMOTER_AGREEMENT_ARTIFACT and set DEPLOYMENT_ENVIRONMENT=staging. The document is deliberately non-legal. Do not change runtime configuration or deploy as part of source preparation. Reconfigure and redeploy through the approved release gate.

For production, obtain founder approval of the complete document and immutable version first. Publish status approved with the exact document hash using reviewed configuration. Do not reuse a staging version, reclassify staging text, or modify text under an existing version. Archive each published document alongside its version and hash in the approved document source. A new version requires new explicit acceptance; historical acceptance records remain preserved.

Authenticated applicants read GET /api/v2/onboarding/promoter-agreement, then explicitly accept its current version through POST /api/v2/onboarding/applications/:requestId/promoter-agreement/accept with an idempotency key. The server verifies application ownership and records actor, timestamp, version, status and hash. Client-supplied text, hash or status is never accepted. Duplicate acceptance does not add records. A changed document under the same version is rejected.

The same selected artifact governs onboarding acceptance, Host assignment eligibility, campaign link creation, and server-side referral revalidation. Historical acquisition records are not rewritten when the current agreement changes.
