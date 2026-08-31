# Staging environment contract

This is the authoritative input contract for a real C1RCLE staging rollout.
The values are deployment-owned and must be supplied by the staging operator;
none are hardcoded in the repository. Run
`node deploy/staging/validate-environment.mjs` before rendering.

## Edge and network

| Value | Required | Contract |
| --- | --- | --- |
| `NGINX_PROFILE` | yes | Must be `staging`. |
| `NGINX_TLS_MODE` | yes | `external` when a verified CDN/WAF/LB owns TLS; `nginx` when this Nginx process owns TLS. |
| `NGINX_SERVER_NAME` | yes | Real staging API hostname; no localhost, example, `.test`, or guessed value. |
| `FASTIFY_UPSTREAM` | yes | One private, resolvable `hostname:port` or `[IPv6]:port`; it must not be a public client endpoint. |
| `PORT` | yes | Fastify listen port; must match the port in `FASTIFY_UPSTREAM`. |
| `NGINX_HTTP_PORT` | yes | Nginx HTTP listen port. |
| `NGINX_HTTPS_PORT` | only for `nginx` TLS | Nginx HTTPS listen port. It is not required when TLS is external. |
| `TRUSTED_PROXY_CIDRS` | yes | Exact Nginx/LB/ingress peer CIDRs consumed by Fastify. `/0` is rejected. |
| `NGINX_READINESS_ALLOWLIST_CIDRS` | yes | Exact health-check source CIDRs. `/0` is rejected. The renderer converts these into Nginx `geo` entries. |
| `NGINX_EDGE_TRUSTED_CIDRS` | only for `external` TLS | Exact CDN/WAF/LB peer CIDRs allowed to supply the outer `X-Forwarded-Proto`. `/0` is rejected. |
| `HOST` | yes | `0.0.0.0` or `::` inside the private Fastify runtime. |

The public listen ports, private subnet/security-group rules, Nginx-to-Fastify
route, and any CDN/WAF/LB hop chain must be recorded by the deployment owner.
The Fastify port must not be publicly exposed. If an external TLS hop exists,
it must be the only party allowed to reach Nginx and must overwrite forwarded
headers before Nginx evaluates them.

For the minimum container topology, publish only the Nginx listener and place
both containers on the same private network:

```text
public edge -> Nginx container -> Fastify container -> Firestore/Storage/Redis
                         private service DNS: FASTIFY_UPSTREAM
```

Fastify must bind `HOST` to `0.0.0.0` (or `::`) inside its container while its
`PORT` remains reachable only through the private network. Do not set
`FASTIFY_UPSTREAM` to `localhost` when Nginx runs in a separate container;
`localhost` would point back to Nginx itself.

## TLS and DNS

`NGINX_TLS_MODE=external` requires no certificate or key variables. The outer
TLS owner must provide HTTPS for the public `STAGING_BASE_URL` and a private
Nginx hop. Nginx accepts the outer proto only from `NGINX_EDGE_TRUSTED_CIDRS`.

`NGINX_TLS_MODE=nginx` requires:

- `NGINX_TLS_CERTIFICATE` — certificate path visible to the Nginx runtime;
- `NGINX_TLS_CERTIFICATE_KEY` — private-key path visible to the Nginx runtime;
- `NGINX_HTTPS_PORT` — HTTPS listener.

The certificate lifecycle, renewal alerting, permissions, and key storage are
deployment responsibilities. `STAGING_BASE_URL` is required for network
preflight and must be the verified HTTPS public API base URL. DNS must point to
the intended staging edge, not directly to Fastify.

## Fastify application

These variables already exist in the gateway configuration and must be explicit
in staging so development defaults cannot silently activate:

| Variable | Required value/behavior |
| --- | --- |
| `NODE_ENV` | `production`, so staging receives production safeguards. |
| `STORAGE_DRIVER` | `firestore`; staging must not fall back to memory. |
| `FIRESTORE_PROJECT_ID` | Verified staging Firebase/Firestore project. |
| `FIREBASE_CLIENT_EMAIL` | Staging service-account email. |
| `FIREBASE_PRIVATE_KEY` | Staging service-account PEM key from the secret source; never commit it or print it. |
| `FIREBASE_STORAGE_BUCKET` | Verified staging Firebase Storage bucket. |
| `ALLOWED_ORIGINS` | Explicit comma-separated HTTPS staging frontend origins; no wildcard. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Explicit comma-separated HTTPS origins. Staging does not rely on the fallback to `ALLOWED_ORIGINS`. |
| `PUBLIC_API_URL` | Verified HTTPS API base URL; hostname must match `NGINX_SERVER_NAME`. |
| `BETTER_AUTH_URL` | Verified HTTPS Better Auth base URL. |
| `BETTER_AUTH_SECRET` | Secret-manager value at least 32 characters; never the development default. |
| `TRUSTED_PROXY_CIDRS` | Exact proxy peer list from the edge section. |
| `APP_VERSION` | Semantic version returned by `/api/v2/internal/version`. |
| `BUILD_SHA` | Actual immutable application commit SHA. |
| `LOG_LEVEL` | Explicit supported value, normally `info`. |
| `REDIS_URL` | Explicit `redis://` or `rediss://` staging endpoint; no localhost fallback. Verify actual Redis usage before relying on it for coordination. |

The gateway's current production validation rejects memory storage, weak
Better Auth secrets, HTTP origins, local hosts, and non-HTTPS public/Auth URLs.
The staging validator additionally rejects missing explicit values and a
Fastify upstream port mismatch. Development/test defaults remain available for
local tests only.

Razorpay variables (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and
`RAZORPAY_WEBHOOK_SECRET`) are required only if the corresponding payment
routes are activated in staging. They are not required by the current route
manifest and must not be fabricated.

## Dependencies and operations

Record these values in the deployment system before the rollout:

- staging Firestore project and Firebase Storage bucket;
- Redis endpoint and whether the active staging path actually uses it;
- secret-manager source and access policy;
- logging destination and retention;
- metrics destination and alerting ownership;
- runtime platform, image registry, immutable image tag/digest, and deployment
  command/process supervisor;
- health-check source, interval, timeout, and termination grace period;
- rollback Nginx image/config digest and rollback Fastify build SHA.

These are deliberately provider-neutral. Do not substitute a guessed
Cloud Run, Kubernetes, VM, Datadog, Grafana, CloudWatch, DNS, or certificate
value for a verified staging decision.
