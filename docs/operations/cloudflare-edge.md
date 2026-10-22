# Running the API behind Cloudflare

How the staging API hostname (`api-staging.thec1rcle.com`) is fronted by Cloudflare, why the gateway can trust the visitor address it is given, and how to roll it out and rotate the secret. Implementation: `deploy/nginx/templates/client-ip.conf.template` and `deploy/docker/nginx-entrypoint.sh`.

## The problem this solves

The API runs in a Render container: nginx in front of Fastify. nginx sees only the platform's proxy as its socket peer (`$remote_addr`), the same address for every visitor. Before this change that made two things wrong:

- the nginx rate-limit zones were keyed on the peer, so **all visitors shared one bucket** (one noisy client could exhaust it for everyone, and no single client could be told apart);
- Fastify received `X-Forwarded-For: <platform proxy>`, so request IPs in logs, audit trails and the app's own per-IP limits were all that one address.

A header saying "the client is X" cannot simply be believed: anyone can send it.

## How it works

```
visitor -> Cloudflare (stamps two headers) -> Render proxy -> nginx (verifies) -> Fastify
```

Cloudflare, which really knows the visitor's address, adds two request headers on this hostname only:

| Header | Value | Set by |
|---|---|---|
| `X-Origin-Verify` | a secret shared only with this container | Cloudflare Transform Rule (static value) |
| `X-C1-Client-IP` | the visitor's address | Cloudflare Transform Rule (`ip.src`) |

nginx believes `X-C1-Client-IP` **only** when `X-Origin-Verify` matches `NGINX_ORIGIN_VERIFY_SECRET` and the value is a well-formed address. In every other case the client is the socket peer, so a forged header changes nothing. The decided address (`$c1rcle_client_ip`) then drives the rate-limit zones and the `X-Forwarded-For` / `X-Real-IP` sent to Fastify. The access log (`clientIp`, with `peerIp` and `originVerified` alongside) carries an **anonymised** form of it: IPv4 truncated to its /24 (`203.0.113.0`) and IPv6 to its /48, anything unparseable as `redacted`. Client addresses are personal data and the platform retains logs; the full address is used for limiting and reaches Fastify, but a log line only needs the network. Both stamped headers are stripped before Fastify.

Because the stamping happens on our own Cloudflare zone, this does not depend on which headers Render's own edge adds or removes, which Render does not document.

### The origin lock

`NGINX_ORIGIN_LOCKED_SERVER_NAMES` lists hostnames that are **refused with 403** unless they carry a valid `X-Origin-Verify`. That closes the bypass where someone resolves Render's origin and sends `Host: api-staging.thec1rcle.com` directly, skipping Cloudflare (and its WAF, rate limiting and access control). Hosts not listed behave exactly as before, so the legacy `onrender.com` name keeps working during a migration.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `NGINX_ORIGIN_VERIFY_SECRET` | no | 32 to 256 characters of letters, digits and `. _ ~ -`. Unset: no verification, the client IP is the socket peer, behaviour identical to before. |
| `NGINX_ORIGIN_LOCKED_SERVER_NAMES` | no | Comma or space separated. Requires the secret, must name served hosts, `api-only` topology only. |

Both are written into nginx config, so they are validated at container start and by `deploy/staging/validate-environment.mjs`; anything malformed exits 64 (fail closed). Generate the secret with `openssl rand -hex 32` and never commit it.

## Cloudflare rule

A Transform Rule (Rules, Transform Rules, Modify Request Header) on the zone, scoped to `http.host eq "api-staging.thec1rcle.com"`, with two header operations:

1. **Set static** `X-Origin-Verify` to the secret.
2. **Set dynamic** `X-C1-Client-IP` to `ip.src`.

Cloudflare overwrites any value the client supplied for these headers, so a client cannot pre-set them. Free plans include this rule type.

## Rollout order (staging)

1. Deploy this change (the new variables are optional, so nothing changes yet).
2. Set `NGINX_ORIGIN_VERIFY_SECRET` on the Render service. The service redeploys.
3. Create the Cloudflare rule above. From this moment requests through Cloudflare carry the secret and the verified address.
4. Confirm in the access log: `clientIp` is the visitor's network (for example `203.0.113.0`), `originVerified` is `1`.
5. Only then set `NGINX_ORIGIN_LOCKED_SERVER_NAMES=api-staging.thec1rcle.com` (redeploys). Setting it before step 3 would lock out the hostname.

## Rotating the secret

There is one active secret, so a rotation has a short window where requests are refused: set the new secret in Render, then update the Cloudflare rule, and expect `403` on the locked host until both match (seconds to a couple of minutes while Render redeploys). Do it at a quiet time. Supporting two accepted secrets at once would remove the window; it is not built.

## What this does not do

- It does not protect the legacy `circle-v2-backend.onrender.com` name; that host is not locked and its client IP is still the platform's peer. Migrate callers (the frontend BFF) to the Cloudflare hostname, then drop the legacy host.
- The secret is visible to anyone who can read the Cloudflare rule or the Render environment. Treat both as secret-bearing.
- Per-client limiting in nginx is only as good as the address Cloudflare reports; users behind one NAT share a limit.
