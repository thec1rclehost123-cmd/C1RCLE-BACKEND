# Nginx rollback

Rollback is deployment-platform work and must use the platform's last known
good immutable image/configuration. Do not edit a live Nginx container by
hand.

## Safe sequence

1. Stop the rollout or route traffic back to the last known-good edge/backend
   revision using the deployment platform's reversible mechanism.
2. Keep the failing Nginx and Fastify logs, request IDs, rendered config, image
   digest, and timestamps for incident review.
3. Confirm the last known-good health endpoint through the real edge and run a
   representative authenticated read before declaring recovery.
4. If the issue is caused by a config value, correct the external value,
   render a new immutable config artifact, run `nginx -t`, and repeat staging
   validation before retrying.
5. If the issue is application behavior, roll back the Fastify artifact with
   the same edge boundary and preserve any data-integrity investigation.

## Staging incident coverage

The rollback owner must be able to identify the previous known-good Nginx
config/image and Fastify build for each of these cases:

- invalid Nginx config or failed reload;
- Fastify proxy-readiness build failure;
- CORS, Better Auth, cookie, or authorization failure;
- bad TLS configuration or certificate mismatch;
- DNS mistake or direct Fastify exposure;
- 502/503/504 spike or latency regression;
- missing/sensitive logging;
- readiness failure or a dependency outage.

For each case, preserve the rendered config, image digest, Fastify `BUILD_SHA`,
request IDs, and the first failing timestamp before rollback. A rollback is not
complete until public health, approved readiness, and a safe authenticated read
work again.

DNS changes and certificate revocation are not first-line rollback tools. Use
them only under the approved incident procedure because propagation and
certificate state are harder to reverse safely.

## Approved Render rollback revision

Automatic rollback requires the repository variable `RENDER_ROLLBACK_SAFE_SHA`
to name an explicitly reviewed full commit SHA. The rollback script restores only
a live deploy for that exact revision. Missing, invalid, failing, or unavailable
revisions refuse rollback. Never select a revision merely because it was live.

For the M1/M2 transition, the previous staging build lacks the workers-OFF guard
and is not an approved rollback target. Leave the variable unset until a guarded
build has passed hosted acceptance. If deployment fails, retain the incident
evidence and stop the service or diagnose and deploy a reviewed fix; do not
restore the known unsafe build. Reassess approval after configuration or data
compatibility changes.
