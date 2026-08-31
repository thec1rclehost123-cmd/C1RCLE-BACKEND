# C1RCLE Nginx edge

## Status

This directory contains the provider-neutral reverse-proxy layer for the
Fastify API gateway. It is implemented and validated by the local/container
harness, but it is not a production deployment. DNS, certificates, firewall
rules, provider load balancers, and process orchestration remain
deployment-owned decisions.

The request path is:

```text
client -> Nginx -> one Fastify gateway instance -> packages/core and storage
```

Nginx is an edge boundary, not a second application layer. It does not make
authorization decisions, create application identities, write Firestore, or
retry API requests.

## Files

- `deploy/nginx/nginx.conf` — worker, logging, compression, timeouts, request
  ID logging, rate-limit zones, and the active `conf.d` include.
- `deploy/nginx/conf.d/api.conf` — local host-installed HTTP profile.
- `deploy/nginx/templates/staging.conf.template` — HTTP-only staging profile.
- `deploy/nginx/templates/production.conf.template` — HTTPS production profile
  with required deployment values left external.
- `deploy/nginx/snippets/proxy-common.conf` — shared upstream header and retry
  policy.
- `deploy/nginx/snippets/api-locations.conf` — shared health, readiness,
  version, API routing, rate protection, and edge-error locations.
- `deploy/nginx/snippets/rate-limits.conf` — conservative edge zones.
- `deploy/nginx/snippets/security-headers.conf` — API-safe security headers.
- `deploy/nginx/snippets/websocket.conf` — inactive future WebSocket policy.
- `deploy/docker/Dockerfile.nginx` — reproducible Nginx validation image.
- `deploy/docker/nginx-entrypoint.sh` — explicit profile rendering; it never
  substitutes arbitrary Nginx variables such as `$host` or `$request_uri`.
- `deploy/nginx/tests/run-local-validation.sh` — builds Fastify, builds Nginx,
  verifies config, proxies real health traffic, checks request IDs, 413/429
  protection, and structured upstream failures.
- `deploy/staging/validate-environment.mjs` — strict staging value and mode
  validation without printing secrets.
- `deploy/staging/render-nginx.mjs` — deterministic, inspectable staging render.
- `deploy/staging/preflight-staging.sh` — environment, render, syntax, DNS,
  direct-health, public-health, and readiness preflight.
- `deploy/staging/smoke-staging.sh` — ordered post-deploy functional checks.
- `deploy/staging/security-tests.sh` — header, host, limits, readiness, TLS,
  log, and direct-access security checks.
- `deploy/staging/failure-tests.sh` — safe invalid-config check plus controlled
  staging failure probes.
- `deploy/staging/load-baseline.sh` — configurable p50/p95/p99 load scenarios.

## Forwarded headers and identity

Nginx overwrites `Host`, `X-Real-IP`, `X-Forwarded-For`,
`X-Forwarded-Proto`, `X-Forwarded-Host`, and `X-Request-Id`. It explicitly
removes `X-User-Id`, `Forwarded`, and `X-Forwarded-Server` rather than allowing
the client to supply an application identity or an untrusted proxy chain.

`Authorization`, `Cookie`, `X-Organization-Id`, `Idempotency-Key`, `If-Match`,
and `X-Client-Request-Id` are preserved for the existing API contract.
Fastify remains responsible for Firebase/Better Auth validation and request
authorization. Its own trusted-proxy CIDR configuration is still required;
Nginx does not make that application decision for it.

The edge-generated `$request_id` is forwarded as `X-Request-Id`, logged in
JSON access logs, and returned by Fastify in its normal error envelope. A
client-provided `X-Request-Id` is not authoritative.

## Health and readiness

- `/api/v2/internal/health` is public so an edge or process monitor can check
  that the gateway is alive.
- `/api/v2/internal/readiness` is denied with `404` unless the rendered profile
  includes the deployment's explicit `NGINX_READINESS_ALLOWLIST_LINES`.
- `/api/v2/internal/version` follows the same readiness allowlist boundary.

Do not put a public load balancer, provider health-check CIDR, or private
network range into the repository. Supply the actual values at deployment
time. For local-only validation, `127.0.0.1/32 1;` is used as an explicit
example; it must not be reused for production unless it is the verified probe
source.

## Safety defaults

- One upstream server and `proxy_next_upstream off` prevent hidden mutation
  retries.
- Request buffering is enabled, cache is not configured, and API responses are
  not cached by Nginx.
- The client body limit is `1m`; connection, send, read, header, and body
  timeouts are bounded.
- General traffic starts at `10r/s` with a burst of `20`; auth traffic starts
  at `5r/s` with a burst of `10`. These are edge protections, not user or
  organization quotas.
- JSON responses are returned for edge-generated `413`, `429`, `502`, `503`,
  and `504` failures, including the edge request ID.
- Compression is limited to text and JSON-like content. There is no upload,
  download, WebSocket, HTTP/3, or cache-specific location in the active
  profile.

## Required deployment values

For staging, provide the complete contract in
[`staging-environment-contract.md`](./staging-environment-contract.md) and
render it with `deploy/staging/render-nginx.mjs`. The runtime must provide at
least:

- `FASTIFY_UPSTREAM` — one resolvable Fastify host and port, such as an
  orchestrator service name; never a guessed address.
- `NGINX_SERVER_NAME` — the verified API hostname.
- `NGINX_READINESS_ALLOWLIST_LINES` — explicit Nginx `geo` entries for the
  verified health-check source networks, for example a deployment-generated
  set of `CIDR 1;` lines.
- `NGINX_HTTP_PORT` — the explicit staging or production HTTP listener.
- `NGINX_EDGE_TRUSTED_CIDR_LINES` — required when staging uses external TLS;
  these are the only peer networks allowed to supply the outer proto.
- `NGINX_HTTPS_PORT`, `NGINX_TLS_CERTIFICATE`, and
  `NGINX_TLS_CERTIFICATE_KEY` — required only when the Nginx-owned TLS profile
  is selected.

The entrypoint is a runtime renderer for already-authorized values. It is not a
replacement for the strict staging validator: run the validator and renderer
first, and preserve the rendered config as a deployment artifact.

Before enabling the production profile, verify TLS termination, certificate
renewal, the real health-check source, firewall rules, log collection, and
Fastify's `TRUSTED_PROXY_CIDRS` together. HSTS is emitted only by the HTTPS
production profile.
