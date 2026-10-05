# Nginx implementation status

## Current status

The provider-neutral Nginx edge is implemented in this repository and has
local and private-container validation. This does not mean the live Render
service is using it.

The currently observed Render path is:

```text
Internet -> Render public service -> Fastify -> Firestore and other dependencies
```

The local target path is:

```text
Internet -> verified TLS edge -> Nginx -> private Fastify -> dependencies
```

The two paths remain separate until Render is deliberately rewired.

## Completed locally

- One public Nginx boundary and one private Fastify upstream.
- Explicit host allowlisting and bounded body, connection, header, send, and
  read timeouts.
- Separate edge rate zones for general and authentication traffic.
- `proxy_next_upstream off` and one upstream server until a verified pool and
  idempotency/session coordination strategy exist.
- Explicit overwrite/clearing of forwarded identity headers.
- Request-ID generation at Nginx, Fastify correlation, and structured access
  logs that omit the query string and request body.
- JSON edge errors for 413, 429, 502, 503, and 504 with request IDs and
  `Cache-Control: no-store`.
- Public liveness plus allowlisted readiness/version routes.
- External TLS and Nginx-owned TLS templates with contradictory values rejected
  by the staging contract validator.
- Bounded Firestore and Firebase Storage readiness probes. Redis remains an
  injectable probe because the current repository has Redis configuration but
  no Redis client or active Redis-owned runtime path. Payment configuration is
  checked only when payment routes are explicitly activated.
- Runtime config rendering checks, Nginx syntax checks, safe reload proof, and
  bounded mutation failure probes.
- An inactive WebSocket policy snippet is prepared, but no WebSocket route is
  enabled.

## Deliberately not enabled

- WebSocket proxying without an actual WebSocket route.
- Upload-specific proxy policy without an active multipart/upload contract.
- Nginx response caching. The edge is no-store; application cache behavior is
  owned by Fastify and is not treated as shared edge cache.
- Multiple Fastify upstreams or load balancing before capacity, sessions,
  Redis coordination, and idempotency are proven.
- Redis health or coordination claims without an actual Redis client.
- Payment-provider health claims while payment routes remain absent from the
  route manifest.

## Render wiring still required

The Render dashboard/deploy logs must supply and verify:

- linked repository, branch, and exact deployed commit;
- Docker versus native Node runtime and the Dockerfile/build/start commands;
- health-check path, exposed port, and auto-deploy policy;
- `FASTIFY_UPSTREAM`, `PORT`, `HOST`, `TRUSTED_PROXY_CIDRS`, and the actual
  Nginx-to-Fastify network boundary;
- `NGINX_PROFILE`, TLS ownership, public hostname, readiness source CIDRs, and
  external-edge trusted CIDRs when applicable;
- Firestore/Firebase credentials, Storage bucket, Redis endpoint, Auth secret,
  public/Auth URLs, origins, app version, build SHA, and log level;
- TLS termination, certificate ownership/renewal, firewall policy, log
  shipping, alerting, and rollback procedure.

Do not copy local Docker test values such as `localhost`, `127.0.0.1/32`, or
`fastify:8080` into Render without verifying that they describe the Render
network.

## Safest next step

Run the strict contract check after the deployment owner provides real values:

```sh
node deploy/staging/validate-environment.mjs
```

Then render the profile, run `nginx -t`, and perform a controlled staging
deployment. Do not change the current Render service or public DNS until the
exact Render service topology and commit are recorded.
