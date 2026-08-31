# Deployment boundary

## Current state

The backend is a Fastify gateway with Nginx-ready proxy behavior. The checked
repository now contains a provider-neutral Nginx image and staging/production
configuration templates, but no cloud or VM deployment has been performed.
The repository does not choose a provider, DNS host, certificate manager,
container scheduler, replica count, or external load balancer.

## Target topology

```text
verified DNS/TLS boundary
          |
       Nginx
          |
  one Fastify gateway instance
          |
  packages/core -> Firebase/Firestore/Redis/external services
```

Start with one Fastify instance. Add replicas and a load-balancing policy only
after the platform, session behavior, Redis coordination, idempotency behavior,
and measured capacity are confirmed. The Nginx configuration deliberately
does not invent that topology.

## Staging procedure

1. Supply the values in
   [`staging-environment-contract.md`](./staging-environment-contract.md),
   including the actual Fastify service name and health-check allowlist.
2. Run `node deploy/staging/validate-environment.mjs`.
3. Render with `node deploy/staging/render-nginx.mjs --output <file>` and run
   `deploy/staging/preflight-staging.sh` before starting anything.
4. Start one Fastify gateway and one Nginx instance. Use external TLS only when
   the verified outer hop is private and its CIDRs are supplied; otherwise use
   the Nginx-owned TLS profile with managed certificate files.
5. Verify `/api/v2/internal/health` through Nginx, then verify the protected
   readiness path from the actual health-check source.
6. Run the ordered smoke, security, failure, and small load baseline scripts
   from [`staging-checklist.md`](./staging-checklist.md). Use only known-safe
   fixtures for authenticated or mutation checks.
7. Observe 413, 429, 502/503/504 behavior, upstream connection counts, request
   latency, error rates, logs, certificate status, and graceful shutdown before
   any production change.

The repository's `deploy/nginx/tests/run-local-validation.sh` is the repeatable
local proof for steps that do not require a real staging network. The staging
preflight and post-deploy suites fail on measured failures and explicitly mark
unavailable external checks as unmeasured. None of these scripts proves DNS,
certificate renewal, firewall policy, provider health-check routing, or
production capacity without real staging infrastructure.

## Production gate

Production may proceed only when the deployment owner supplies and verifies:

- the real API hostname and DNS change plan;
- a managed certificate and renewal/expiry alerting;
- the Nginx runtime's secret/file permissions;
- the actual Fastify upstream address and process supervisor;
- the health-check source CIDRs and firewall policy;
- `TRUSTED_PROXY_CIDRS` matching the real proxy chain;
- log shipping, metrics, alerting, and an operator rollback path;
- a tested staging run with authenticated and mutation flows.

No production DNS, TLS, replica, or firewall values are embedded in this
repository.
