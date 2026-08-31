# Staging deployment checklist

Use this checklist in order. A missing external value or unmeasured blocking
check is NO-GO.

## Pre-deploy

- [ ] Provide the values in [`staging-environment-contract.md`](./staging-environment-contract.md).
- [ ] Run `deploy/staging/tests/run-container-integration.sh` and retain its
      output as local container evidence.
- [ ] Confirm the runtime platform, image registry, process supervisor, and
      rollback artifact.
- [ ] Confirm the public staging hostname, DNS owner, TLS owner, and hop chain.
- [ ] Confirm Fastify is private and Nginx is the only public API ingress.
- [ ] Confirm health-check source CIDRs and exact trusted proxy CIDRs.
- [ ] Run `node deploy/staging/validate-environment.mjs`.
- [ ] Render with `node deploy/staging/render-nginx.mjs --output <file>` and
      inspect the file without committing it.
- [ ] Run `deploy/staging/preflight-staging.sh` with real values.
- [ ] Verify the Fastify build SHA and Nginx image digest are immutable.

## Deploy

- [ ] Deploy the Fastify build with `NODE_ENV=production`, Firestore storage,
      staging Firebase credentials, and the explicit staging origins.
- [ ] Deploy one Nginx instance/profile with the rendered config.
- [ ] Configure the verified DNS record and TLS ownership.
- [ ] Configure private networking, firewall rules, log shipping, and health
      checks.
- [ ] Verify public health and approved-source readiness before traffic use.

## Post-deploy gates

- [ ] Run `deploy/staging/smoke-staging.sh`.
- [ ] Run `deploy/staging/security-tests.sh`.
- [ ] Run `deploy/staging/load-baseline.sh` with `STAGING_LOAD_CONFIRM=YES`.
- [ ] Run `deploy/staging/failure-tests.sh` for isolated/approved failure
      probes only.
- [ ] Verify request rate, 4xx, 429, 5xx, 502/503/504, latency, upstream
      latency, active connections, readiness, availability, and certificate
      monitoring from [`staging-observability.md`](./staging-observability.md).
- [ ] Prove rollback to the previous Nginx config/image and Fastify SHA.

## GO / NO-GO

- [ ] GO only when all blocking checks pass, external values are verified, and
      rollback is executable.
- [ ] NO-GO when any placeholder, direct Fastify exposure, broad readiness
      access, header spoofing, auth/cookie failure, TLS failure, 502 spike,
      latency regression, logging gap, or unmeasured required gate remains.
