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
| `FASTIFY_PORT` | Render split preflight | Private Fastify listen port; must match `FASTIFY_UPSTREAM`. Use `8080` on Render because private-network port `10000` is reserved. |
| `PORT` | Render-provided for the public edge | Nginx Web Service listener. Do not hardcode Render's default. |
| `NGINX_HTTP_PORT` | non-Render deployments only | Explicit Nginx HTTP listener; the container falls back to `PORT`. |
| `NGINX_HTTPS_PORT` | only for `nginx` TLS | Nginx HTTPS listen port. It is not required when TLS is external. |
| `TRUSTED_PROXY_CIDRS` | yes | Exact Nginx/LB/ingress peer CIDRs consumed by Fastify. `/0` is rejected. |
| `NGINX_READINESS_TOKEN` | yes | 32+ byte random secret. Callers send it as `X-Readiness-Token` to reach `/readiness`/`/version`. Not an IP allowlist — Render's edge terminates and reconnects, so `$remote_addr` cannot gate this. |
| `NGINX_FORWARDED_PROTO` | only for `external` TLS | Deployment-owned public scheme. Set `https` for Render. Incoming forwarding headers are ignored. |
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
TLS owner must provide HTTPS for the public `STAGING_BASE_URL`. For Render,
set `NGINX_FORWARDED_PROTO=https`; Nginx writes that known deployment scheme
and ignores incoming forwarding identity instead of relying on unpublished
Render proxy CIDRs.

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
| `BUILD_SHA` | Optional explicit immutable commit SHA. On Render, the gateway and preflight fall back to documented `RENDER_GIT_COMMIT`. |
| `LOG_LEVEL` | Explicit supported value, normally `info`. |
| `REDIS_URL` | Optional until a Redis client owns an active runtime path. If supplied, it must be a non-local `redis://` or `rediss://` endpoint. |

The gateway's current production validation rejects memory storage, weak
Better Auth secrets, HTTP origins, local hosts, and non-HTTPS public/Auth URLs.
The staging validator additionally rejects missing explicit values and a
Fastify upstream port mismatch. Development/test defaults remain available for
local tests only.

Razorpay variables (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and
`RAZORPAY_WEBHOOK_SECRET`) are required only if the corresponding payment
routes are activated in staging. They are not required by the current route
manifest and must not be fabricated.

## Render staging split

The public `circle-v2-edge-staging` Web Service uses the Nginx Dockerfile and
Render's injected `PORT`. The private `circle-v2-backend-staging` service uses
the root Dockerfile with explicit `PORT=8080` and `HOST=0.0.0.0`. Both must be
in the same Render workspace, environment, and Singapore region. Use the
private service address from Render's Connect panel as `FASTIFY_UPSTREAM`.

Render Private Services support only TCP health checks. Configure the public
Nginx Web Service HTTP health path as `/api/v2/internal/health`; keep readiness
and version restricted by `NGINX_READINESS_TOKEN`. The exact stable
source range that Fastify should trust for the Nginx private hop is not
published in the repository or Render's general private-network documentation.
`TRUSTED_PROXY_CIDRS` therefore remains a blocking value to obtain and verify;
never replace it with `/0` or `trustProxy: true`.

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
