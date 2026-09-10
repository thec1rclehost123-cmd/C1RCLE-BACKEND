# Render staging topology

This checklist prepares two new staging services. It does not modify or reuse
the live `circle-v2-backend` Production service.

```text
Internet -> Render TLS -> circle-v2-edge-staging (Nginx, public PORT)
                       -> Render private network
                       -> circle-v2-backend-staging (Fastify, 0.0.0.0:8080)
                       -> staging Firestore / Storage
```

## Service definitions

| Setting | Nginx edge | Fastify backend |
| --- | --- | --- |
| Name | `circle-v2-edge-staging` | `circle-v2-backend-staging` |
| Type | Web Service | Private Service |
| Runtime | Docker | Docker |
| Dockerfile | `deploy/docker/Dockerfile.nginx` | `Dockerfile` |
| Build context | repository root | repository root |
| Branch | the explicitly selected staging commit/branch | the same commit/branch |
| Region | Singapore | Singapore |
| Public exposure | yes | none |
| Listener | `0.0.0.0:$PORT` via Nginx entrypoint | `0.0.0.0:8080` |
| Health | HTTP `/api/v2/internal/health` | Render TCP check only |
| TLS | Render-owned | none; private HTTP |

Render reserves private-network port `10000`, so the private Fastify service
must explicitly stay on `8080`. Do not set the public Nginx port to a guessed
number; Render supplies `PORT` to the Web Service.

## Fastify environment

### Code-to-Render classification

| Variable | Classification | Current behavior |
| --- | --- | --- |
| `NODE_ENV` | REQUIRED | Docker defaults to `production`; set explicitly for staging safeguards. |
| `PORT` | REQUIRED | Fastify respects it; set private service to `8080`. Render injects it only for the public Web Service. |
| `HOST` | DEFAULTED / REQUIRED | Defaults to `0.0.0.0`; keep explicit on the private service. |
| `LOG_LEVEL` | OPTIONAL / DEFAULTED | Defaults to `info`. |
| `STORAGE_DRIVER` | REQUIRED | Production validation requires `firestore`. |
| `FIRESTORE_PROJECT_ID` | REQUIRED | Has a development default that staging must not use implicitly. |
| `FIREBASE_CLIENT_EMAIL` | REQUIRED | Required with Firestore. |
| `FIREBASE_PRIVATE_KEY` | REQUIRED | Required with Firestore; secret value. |
| `FIREBASE_STORAGE_BUCKET` | REQUIRED NOW | Code can derive a bucket, but staging requires the verified bucket explicitly. |
| `BETTER_AUTH_SECRET` | REQUIRED | Production requires at least 32 non-development characters. |
| `BETTER_AUTH_URL` | REQUIRED | Must be the HTTPS staging edge URL. |
| `PUBLIC_API_URL` | REQUIRED | Must be the HTTPS staging edge URL. |
| `ALLOWED_ORIGINS` | REQUIRED | Explicit HTTPS browser origins; no wildcard. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | REQUIRED NOW | Code can inherit CORS origins, but staging keeps this explicit. |
| `TRUSTED_PROXY_CIDRS` | MISSING-BUT-NEEDED | Exact Nginx private source range is not yet proven. |
| `APP_VERSION` | REQUIRED | Explicit semantic staging version. |
| `BUILD_SHA` | RENDER-INJECTED / OPTIONAL | Falls back to documented `RENDER_GIT_COMMIT`. |
| `REDIS_URL` | FUTURE-ONLY | Default exists, but no active Redis client uses it. |
| `RAZORPAY_KEY_ID` | FUTURE-ONLY | Omit while payment HTTP routes are inactive. |
| `RAZORPAY_KEY_SECRET` | FUTURE-ONLY | Omit while payment HTTP routes are inactive. |
| `RAZORPAY_WEBHOOK_SECRET` | FUTURE-ONLY | Omit while payment/webhook HTTP routes are inactive. |

Required now:

- `NODE_ENV=production`
- `PORT=8080`
- `HOST=0.0.0.0`
- `STORAGE_DRIVER=firestore`
- `FIRESTORE_PROJECT_ID=<STAGING_FIRESTORE_PROJECT_ID>`
- `FIREBASE_CLIENT_EMAIL=<STAGING_FIREBASE_CLIENT_EMAIL>`
- `FIREBASE_PRIVATE_KEY=<STAGING_FIREBASE_PRIVATE_KEY_SECRET>`
- `FIREBASE_STORAGE_BUCKET=<STAGING_FIREBASE_STORAGE_BUCKET>`
- `BETTER_AUTH_SECRET=<STAGING_BETTER_AUTH_SECRET>`
- `BETTER_AUTH_URL=https://<STAGING_EDGE_HOSTNAME>`
- `PUBLIC_API_URL=https://<STAGING_EDGE_HOSTNAME>`
- `ALLOWED_ORIGINS=https://<STAGING_PARTNER_HOSTNAME>[,https://<OTHER_STAGING_ORIGIN>]`
- `BETTER_AUTH_TRUSTED_ORIGINS=<THE_EXPLICIT_STAGING_ORIGIN_LIST>`
- `TRUSTED_PROXY_CIDRS=<VERIFIED_NGINX_PRIVATE_SOURCE_CIDR_LIST>`
- `APP_VERSION=<SEMANTIC_STAGING_VERSION>`

Optional now:

- `LOG_LEVEL=info` (gateway default is `info`)
- `BUILD_SHA=<DEPLOY_COMMIT>` only when overriding Render's documented
  `RENDER_GIT_COMMIT`

Future Redis:

- `REDIS_URL=<STAGING_REDIS_URL>` is optional and does not block the first
  staging rollout. Redis is configured but no active Redis client owns
  readiness or distributed coordination. Keep one Fastify replica.

Future payments:

- Omit `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and
  `RAZORPAY_WEBHOOK_SECRET` for the initial staging topology. Checkout,
  payment, and webhook HTTP routes are not registered. Door-sale payment-mode
  records do not invoke Razorpay. Before activating payments, use only a
  complete Razorpay test credential set and add an explicit activation gate;
  never copy Production credentials by default.

Render-provided:

- `RENDER=true`
- `RENDER_GIT_COMMIT` (used automatically as `BUILD_SHA` when no override is set)
- `RENDER_GIT_BRANCH`, `RENDER_GIT_REPO_SLUG`, and service metadata documented
  by Render

## Nginx environment

Set these on `circle-v2-edge-staging`:

- `NGINX_PROFILE=staging`
- `NGINX_SERVER_NAME=<STAGING_EDGE_ONRENDER_HOSTNAME>`
- `FASTIFY_UPSTREAM=<FASTIFY_PRIVATE_HOSTNAME>:8080`
- `NGINX_FORWARDED_PROTO=https`
- `NGINX_READINESS_TOKEN=<32+ byte random secret>` — callers must send it
  as `X-Readiness-Token` to reach `/readiness`/`/version`. IP-based gating
  does not work here: Render's edge terminates and reconnects, so
  `$remote_addr` never reflects the real caller.

Do not set `NGINX_HTTP_PORT`; the entrypoint consumes Render's injected `PORT`.
Do not configure an HTTPS listener or certificate in Nginx. Request IDs are
always regenerated at Nginx and forwarded to Fastify. Current fixed safeguards
are: `1m` request bodies, `10r/s` general with burst `20`, `5r/s` auth with
burst `10`, `100` connections per edge peer, `5s` connect timeout, and `30s`
send/read timeouts. Tune only after measured staging load.

The combined operator preflight additionally uses
`NGINX_TLS_MODE=external`, `FASTIFY_PORT=8080`,
`NGINX_READINESS_TOKEN`, and all required Fastify values. These are
validation inputs, not additional Nginx container requirements.

## Trusted proxy blocker

Fastify receives the Nginx private-network socket address. Render documents
private hostnames and dynamic instance addresses, but the repository does not
have a proven stable Nginx source CIDR. Before authenticated staging tests,
obtain the exact supported trust boundary from Render or measure and document
an operator-approved narrow address range. The validator rejects `0.0.0.0/0`,
`::/0`, blank lists, and malformed CIDRs. Do not use `trustProxy: true`.

This does not prevent creating the services, but it prevents declaring the
forwarded identity/protocol boundary verified until the value is supplied.

## Ordered manual checklist

- [ ] Create a separate Render Staging environment; enable cross-environment
      private-network isolation when the workspace plan supports it.
- [ ] Create `circle-v2-backend-staging` as a Singapore Private Service.
- [ ] Select Docker, root `Dockerfile`, root build context, and the intended
      commit/branch; disable auto-deploy until live staging is accepted.
- [ ] Set the Fastify environment above using staging-only Firebase resources.
- [ ] Confirm its Service Address and TCP check; record the private hostname.
- [ ] Create `circle-v2-edge-staging` as a Singapore Web Service.
- [ ] Select Docker, `deploy/docker/Dockerfile.nginx`, root build context, and
      the same commit/branch; disable auto-deploy initially.
- [ ] Set the Nginx environment above using the actual private Service Address.
- [ ] Set HTTP health check path `/api/v2/internal/health`.
- [ ] Run local `deploy/staging/preflight-staging.sh --render-dry-run`, then the
      real preflight with the dashboard values.
- [ ] Deploy Fastify first, then Nginx; confirm Fastify has no public URL.
- [ ] Run health, readiness/version boundary, smoke, auth, and security tests.
- [ ] Run the small approved load baseline and failure/restart tests.
- [ ] Record both image/deploy SHAs, logs, service IDs, and rollback targets.
- [ ] Roll back either staging service independently if a gate fails.
- [ ] Do not change Production DNS, the existing Production service, or its
      environment during staging validation.

No production cutover is authorized by this checklist.
