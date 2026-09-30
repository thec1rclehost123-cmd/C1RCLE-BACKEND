# Staging observability gate

Staging is not rollout-successful until the deployment owner can query these
signals for the same time window and correlate them with `X-Request-Id`.
Choose the monitoring/logging provider outside this repository; no provider is
assumed here.

## Required signals

| Signal | Source | Minimum evidence |
| --- | --- | --- |
| Request rate | Nginx access logs/metrics | Requests per minute, split by route family and status. |
| 4xx rate | Nginx and Fastify | Count and rate excluding expected validation/auth traffic. |
| 429 rate | Nginx | Count, source distribution, and rate-limit zone. |
| 5xx rate | Nginx and Fastify | Total 5xx with separate upstream failures. |
| 502/503/504 | Nginx | Separate counts and request IDs for every edge-generated failure. |
| Request latency | Nginx | p50, p95, and p99 request time. |
| Upstream latency | Nginx | p50, p95, and p99 upstream response time. |
| Active connections | Nginx | Current and peak connections compared with the chosen limit. |
| Fastify readiness | `/api/v2/internal/readiness` | Approved health-check result and each dependency check. |
| Nginx availability | Edge health URL | Success rate and probe latency through the public path. |
| Certificate expiry | TLS owner | Expiry date and renewal alert when Nginx or the external TLS owner handles TLS. |

## Log requirements

The Nginx JSON access log includes timestamp, request ID, remote address,
request line, status, response bytes, request time, upstream address/status,
upstream response time, and user agent. It intentionally does not log
`Authorization`, cookies, request bodies, or secret values. Fastify logs and
the deployment platform must preserve the same request ID without adding
credential material.

Retain enough staging data to investigate a failed rollout, then apply the
approved retention and redaction policy. Do not paste service-account keys,
Better Auth secrets, session cookies, or bearer tokens into logs or incident
notes.

## Rollout evidence

Capture before declaring GO:

- one successful public health request and one approved-source readiness
  request with their request IDs;
- a representative authenticated read and safe mutation with edge and
  Fastify correlation;
- baseline p50/p95/p99, throughput, 4xx/429/5xx, and 502/503/504 counts;
- certificate status if TLS is active;
- the rendered Nginx config, image digest, Fastify build SHA, and rollback
  artifact identifiers.
