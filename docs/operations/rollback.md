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
