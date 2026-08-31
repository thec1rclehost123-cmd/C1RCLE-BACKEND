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

1. Build the Nginx image from the repository root using
   `deploy/docker/Dockerfile.nginx`.
2. Supply the staging values described in
   [`nginx.md`](./nginx.md), including the actual Fastify service name and
   health-check allowlist.
3. Render the HTTP-only staging profile and run `nginx -t` before starting it.
4. Start one Fastify gateway and one Nginx instance.
5. Verify `/api/v2/internal/health` through Nginx, then verify the protected
   readiness path from the actual health-check source.
6. Exercise one authenticated read and one representative mutation with a
   known-safe test record. Confirm the same `X-Request-Id` appears at the edge,
   Fastify, and centralized logs.
7. Observe 413, 429, 502/503/504 behavior, upstream connection counts, request
   latency, error rates, and graceful shutdown before any production change.

The repository's `run-local-validation.sh` is the repeatable local proof for
steps that do not require a real staging network. It does not prove DNS,
certificate renewal, firewall policy, provider health-check routing, or
production capacity.

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
