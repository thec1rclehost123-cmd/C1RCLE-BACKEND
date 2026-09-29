# Architecture

> **Last verified:** `69687f7` — 2026-09-09 — run `bash docs/nginx/regenerate.sh` to refresh

This document describes the full nginx architecture: where it sits, what it
touches, and what it deliberately does not touch.

---

## Container Layout

### Target: Two-Service Private Network

```mermaid
graph TB
  subgraph Internet["Internet"]
    Browser[Browser / Mobile App]
  end

  subgraph Render["Render Platform"]
    subgraph PublicEdge["Public Web Service"]
      RenderTLS[Render TLS<br/>Certificate termination]
      NginxContainer["Nginx container<br/>Dockerfile.nginx<br/>nginx:1.27-alpine<br/>USER nginx"]
    end

    subgraph PrivateNetwork["Render Private Network"]
      FastifyContainer["Fastify container<br/>Dockerfile<br/>node:24-slim + tsx<br/>USER app"]
      Firestore[(Firestore)]
      Storage[(Firebase Storage)]
    end
  end

  Browser -->|"HTTPS"| RenderTLS
  RenderTLS -->|"HTTP via Render internal proxy"| NginxContainer
  NginxContainer -->|"HTTP :8080<br/>service DNS: FASTIFY_UPSTREAM"| FastifyContainer
  FastifyContainer --> Firestore
  FastifyContainer --> Storage

  style PublicEdge fill:#e0f0ff,stroke:#36a
  style PrivateNetwork fill:#f0f0ff,stroke:#36a
```

**Key facts:**
- Nginx runs as a **Web Service** (public) on Render
- Fastify runs as a **Private Service** (not publicly accessible)
- Fastify port `8080` is **never** host-mapped — only reachable via private
  service DNS (`FASTIFY_UPSTREAM`)
- Render reserves private-network port `10000` — Fastify uses `8080`
- Both containers are on the same private Docker network

### Current: Single-Service (Live on Render)

```mermaid
graph TB
  Browser[Browser] -->|HTTPS| RenderEdge[Render TLS]
  RenderEdge -->|HTTP :8080| FastifyAlone["Fastify container<br/>(sole service)"]
  FastifyAlone --> Firestore[(Firestore)]
  FastifyAlone --> Storage[(Firebase Storage)]

  style FastifyAlone fill:#fff0e0,stroke:#c90
```

This is the current live topology. Nginx exists in the codebase and is
locally validated, but the live Render service has not been rewired yet.
See [`../operations/nginx-implementation-status.md`](../operations/nginx-implementation-status.md).

---

## Local Development Topology

```mermaid
graph TB
  subgraph Host["Your Machine"]
    BrowserDev[Browser] -->|:3000/:3001/:3002| NextJS[Next.js BFF]
    NextJS -->|"server-side fetch<br/>localhost:8081"| NginxLocal["Nginx (host)<br/>:8081"]
    NginxLocal -->|"127.0.0.1:8080<br/>proxy_pass"| FastifyLocal["Fastify (host)<br/>:8080"]
    FastifyLocal -->|"HTTP"| FirebaseEmu[Firebase Emulators<br/>:5001, :8080, :9000]
  end

  subgraph Docker["Docker (optional)"]
    NginxContainer["nginx:1.27-alpine"] -->|"fastify:8080"| FastifyContainer["Fastify container"]
  end
```

**Local development** uses the host-installed Nginx profile:
- `deploy/nginx/conf.d/api.conf` — hardcoded `127.0.0.1:8080` upstream
- Nginx listens on `:8081`
- No TLS, no template rendering, no envsubst
- Readiness allowlist is open (`geo default 1`)

---

## The Trusted-Proxy Boundary

The most important security property of the nginx layer: **Nginx overwrites
all identity headers** so Fastify only sees values it trusts.

```mermaid
flowchart TD
  subgraph Incoming["Incoming request from client"]
    ClientHost["Host: api.circle1.com"]
    ClientXFF["X-Forwarded-For: 203.0.113.50"]
    ClientProto["X-Forwarded-Proto: https"]
    ClientUser["X-User-Id: admin"]
    ClientTrueIP["True-Client-IP: 203.0.113.50"]
    ClientCF["CF-Connecting-IP: 203.0.113.50"]
  end

  subgraph Nginx["Nginx proxy-common.conf — what happens"]
    direction TB
    HostSet["Host → $host (from request)"]
    XFFSet["X-Forwarded-For → $remote_addr<br/>(socket peer, NOT client header)"]
    ProtoSet["X-Forwarded-Proto → $c1rcle_forwarded_proto<br/>(deployment-owned, NOT client header)"]
    RealIPSet["X-Real-IP → $remote_addr"]
    ReqIdSet["X-Request-Id → $request_id<br/>(edge-generated UUID)"]
    BlankUser["X-User-Id → ''"]
    BlankServer["X-Forwarded-Server → ''"]
    BlankTrueIP["True-Client-IP → ''"]
    BlankCF["CF-Connecting-IP → ''"]
    BlankOriginal["X-Original-For, X-Original-Host,<br/>X-Original-Proto, X-Original-Url → ''"]
    BlankForwarded["Forwarded → ''"]
  end

  subgraph Outgoing["Headers reaching Fastify"]
    FastHost["Host: api.circle1.com"]
    FastXFF["X-Forwarded-For: 127.0.0.1 (nginx peer)"]
    FastProto["X-Forwarded-Proto: https"]
    FastRealIP["X-Real-IP: 127.0.0.1"]
    FastReqId["X-Request-Id: edge-uuid-123"]
    FastEmpty["X-User-Id, True-Client-IP, etc. = ''"]
    FastAuth["Authorization: Bearer ... (preserved)"]
    FastCookie["Cookie: ... (preserved)"]
    FastOrg["X-Organization-Id: ... (preserved)"]
  end

  Incoming --> Nginx --> Outgoing

  style Nginx fill:#ffe0e0,stroke:#c33
  style Outgoing fill:#e0ffe0,stroke:#3a3
```

### What Nginx Overwrites (trust boundary)

| Header | Nginx sets to | Source |
|---|---|---|
| `Host` | `$host` | Client request Host header |
| `X-Real-IP` | `$remote_addr` | Socket peer address |
| `X-Forwarded-For` | `$remote_addr` | Socket peer address (NOT appended) |
| `X-Forwarded-Proto` | `$c1rcle_forwarded_proto` | Deployment-owned map, NOT client header |
| `X-Forwarded-Host` | `$host` | Client request Host header |
| `X-Request-Id` | `$request_id` | Nginx-generated edge UUID |

### What Nginx Blanks (prevents spoofing)

| Header | Set to |
|---|---|
| `X-User-Id` | `""` |
| `X-Forwarded-Server` | `""` |
| `X-Forwarded-Port` | `""` |
| `X-Forwarded-Ssl` | `""` |
| `Forwarded` | `""` |
| `X-Original-For` | `""` |
| `X-Original-Host` | `""` |
| `X-Original-Proto` | `""` |
| `X-Original-Url` | `""` |
| `X-Client-IP` | `""` |
| `True-Client-IP` | `""` |
| `CF-Connecting-IP` | `""` |

### What Nginx Preserves (application contract)

| Header | Reason |
|---|---|
| `Authorization` | Bearer token for Better Auth |
| `Cookie` | Session cookies (BFF passes them) |
| `X-Organization-Id` | Multi-tenant scope |
| `Idempotency-Key` | Mutation deduplication |
| `If-Match` | ETag/optimistic concurrency |
| `X-Client-Request-Id` | Client-side request correlation |
| `Content-Type` | Request body format |
| `Content-Length` | Request body size |

---

## Request-ID Lifecycle

```mermaid
sequenceDiagram
    participant Client as Client / BFF
    participant Nginx as Nginx Edge
    participant Fastify as Fastify Gateway
    participant Log as Structured Logs

    Client->>Nginx: GET /api/v2/tickets
    Note over Nginx: Generates $request_id<br/>(UUID4, not from client)
    Nginx->>Nginx: Sets X-Request-Id: $request_id<br/>Sets X-Forwarded-For: $remote_addr
    Nginx->>Fastify: proxy_pass with X-Request-Id
    Note over Fastify: genReqId checks:<br/>1. Is X-Request-Id present?<br/>2. Is format valid?<br/>3. Is peer a trusted proxy?<br/>→ All yes: accept edge ID<br/>→ No: generate fresh UUID
    Fastify->>Fastify: Uses X-Request-Id as request.id
    Fastify->>Fastify: onRequestHook echoes<br/>x-request-id on response
    Fastify-->>Nginx: Response with x-request-id
    Nginx->>Log: {"requestId":"edge-uuid",<br/>"status":200,<br/>"upstreamResponseTime":"12ms"}
    Nginx-->>Client: Response + x-request-id header
```

**Key properties:**
- Nginx is the **authoritative generator** of request IDs
- Fastify only accepts an incoming `X-Request-Id` if the socket peer is a
  configured trusted proxy (CIDR match via `TRUSTED_PROXY_CIDRS`)
- Client-provided `X-Request-Id` values are **ignored** for non-trusted peers
- Request IDs appear in: Nginx JSON logs, Fastify error envelopes, response
  headers

---

## Fastify's Trust Configuration

Nginx does not make the trusted-proxy decision for Fastify. Fastify has its
own `trustProxy` setting that checks the socket peer against
`TRUSTED_PROXY_CIDRS`.

```mermaid
flowchart TD
  Fastify[Fastify gateway<br/>app.ts:47] --> TrustCheck{"trustProxy:<br/>(address) =><br/>trustedProxyMatcher(address)"}
  TrustCheck -->|"Peer matches<br/>TRUSTED_PROXY_CIDRS"| Trusted["Accept X-Forwarded-For<br/>Accept X-Request-Id<br/>Use for rate limiting"]
  TrustCheck -->|"Peer does NOT match"| Untrusted["Ignore forwarding headers<br/>Generate fresh request ID<br/>Rate limit by socket peer"]
```

**Configuration:** `apps/api-gateway/src/config/index.ts` — `TRUSTED_PROXY_CIDRS`
env var, comma-separated CIDR list. `/0` (unrestricted) is rejected at cold start.

**Default for local dev:** `127.0.0.1,::1` — the localhost peers (Nginx and
Fastify run on the same machine).

**Required for staging:** The actual Nginx container's private IP range on the
Render private network.

---

## Edge Error Response Flow

When Nginx itself generates an error (before or instead of proxying to Fastify),
it returns structured JSON:

```mermaid
flowchart TD
  Request[Incoming request] --> Checks{Edge checks}
  Checks -->|"Body > 1m"| E413["413<br/>edge_request_too_large"]
  Checks -->|"Rate limit exceeded"| E429["429<br/>edge_rate_limited"]
  Checks -->|"Fastify unreachable"| E502["502<br/>edge_upstream_unavailable"]
  Checks -->|"Fastify returns 503"| E503["503<br/>edge_upstream_unavailable"]
  Checks -->|"Fastify timeout > 30s"| E504["504<br/>edge_upstream_timeout"]
  Checks -->|"Passes all checks"| Proxy["proxy_pass → Fastify"]

  E413 --> JSON["JSON response body:<br/>{status, code, message, requestId}<br/>+ X-Request-Id header<br/>+ Cache-Control: no-store"]
  E429 --> JSON
  E502 --> JSON
  E503 --> JSON
  E504 --> JSON

  style JSON fill:#ffe0e0,stroke:#c33
```

All edge errors include:
- `X-Request-Id` header (the Nginx-generated edge ID)
- `Cache-Control: no-store`
- Security headers (nosniff, no-referrer)
- JSON body with `status`, `code`, `message`, `requestId`

---

## Location Matching Order

Nginx evaluates locations in this order (first match wins):

```mermaid
flowchart TD
  Req[Request: /api/v2/anything] --> Exact1{"/api/v2/internal/health"?}
  Exact1 -->|"Yes"| Health["Health check<br/>Public, no rate limit"]
  Exact1 -->|"No"| Exact2{"/api/v2/internal/readiness?"}
  Exact2 -->|"Yes + in allowlist"| Readiness["Readiness check<br/>Rate-limited"]
  Exact2 -->|"No OR not in allowlist"| Readiness404["404 (not in allowlist)"]
  Exact2 -->|"No"| Exact3{"/api/v2/internal/version?"}
  Exact3 -->|"Yes + in allowlist"| Version["Version endpoint<br/>Rate-limited"]
  Exact3 -->|"No OR not in allowlist"| Version404["404 (not in allowlist)"]
  Exact3 -->|"No"| PrefixAuth{"Starts with<br/>/api/v2/auth/ ?"}
  PrefixAuth -->|"Yes"| AuthRate["Auth rate limit<br/>5r/s, burst=10"]
  PrefixAuth -->|"No"| PrefixAPI{"Starts with<br/>/api/v2/ ?"}
  PrefixAPI -->|"Yes"| GeneralRate["General rate limit<br/>10r/s, burst=20"]
  PrefixAPI -->|"No"| NotFound["Nginx default 404"]
```

**Three tiers of routing:**
1. **Exact matches** (`location =`): health, readiness, version — highest priority
2. **Prefix match with priority** (`location ^~`): `/api/v2/auth/` catches auth
   routes before the general `/api/v2/` prefix
3. **General prefix** (`location ^~`): `/api/v2/` catches everything else

**Security note:** `/api/v2/internal/readiness` and `/api/v2/internal/version`
return `404` when the requesting IP is not in `NGINX_READINESS_TOKEN`.
This prevents internal deployment metadata from being publicly visible.
