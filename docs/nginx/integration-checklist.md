# Integration Checklist

> **Last verified:** `69687f7` — 2026-09-09 — run `bash docs/nginx/regenerate.sh` to refresh

This document covers backend ↔ frontend integration concerns when nginx is
in the picture. Use this as a checklist when wiring the Next.js BFF or
mobile app through the nginx edge.

---

## Env Var Dependencies

```mermaid
flowchart TD
  subgraph BFF["Next.js BFF (guest-portal / partner-dashboard)"]
    BFF_FETCH["fetch() calls"]
    BFF_CSRF["CSRF token handling"]
    BFF_COOKIE["Cookie forwarding"]
  end

  subgraph Nginx["Nginx Edge"]
    NG_RATE["Rate limiting<br/>10r/s general, 5r/s auth"]
    NG_HEADERS["Header washing"]
    NG_BODY["Body size limit: 1m"]
  end

  subgraph Fastify["Fastify Gateway"]
    F_AUTH["Better Auth<br/>(session validation)"]
    F_TRUST["trustProxy check<br/>(TRUSTED_PROXY_CIDRS)"]
    F_ORG["Organization scope<br/>(X-Organization-Id)"]
    F_RATE["Application rate limiting<br/>(in-memory sliding window)"]
  end

  BFF_FETCH --> NG_RATE
  BFF_FETCH --> NG_BODY
  BFF_CSRF --> F_AUTH
  BFF_COOKIE --> NG_HEADERS
  NG_HEADERS --> F_TRUST
  NG_HEADERS --> F_ORG
  NG_RATE --> F_RATE
```

---

## CSRF and Cookie Boundary

```mermaid
flowchart TB
  subgraph Browser["Browser"]
    Cookie["Session cookie<br/>(HttpOnly, Secure, SameSite=Lax)"]
  end

  subgraph BFF["Next.js BFF (server-side)"]
    BFFReceive["Receives cookie from browser"]
    BFFForward["Forwards cookie to Nginx<br/>via proxy_set_header Cookie"]
    BFFNoCookie["BFF does NOT read<br/>session cookie contents"]
  end

  subgraph Nginx["Nginx Edge"]
    NginxPass["Passes Cookie header<br/>to Fastify unchanged"]
  end

  subgraph Fastify["Fastify Gateway"]
    AuthCheck["Better Auth reads cookie<br/>validates session"]
  end

  Cookie -->|"HTTPS"| BFFReceive
  BFFReceive --> BFFForward
  BFFForward -->|"proxy_pass"| NginxPass
  NginxPass --> AuthCheck

  style BFFReceive fill:#e0ffe0
  style NginxPass fill:#e0f0ff
```

**Key insight:** The BFF makes server-side HTTP requests to Nginx. The
browser's session cookie is forwarded through the entire chain. Nginx
passes it through unchanged (it is in the "preserve" list in
`proxy-common.conf`).

**What the BFF needs:**
- `NEXT_PUBLIC_API_URL` or equivalent — pointing to the Nginx public URL
  (not Fastify directly)
- CSRF token handling — the BFF generates and validates CSRF tokens for
  browser requests; server-side API calls through Nginx don't need CSRF

---

## CORS Configuration

```mermaid
flowchart TD
  Browser[Browser] -->|"Origin: https://staging.circle1.com"| NginxEdge[Nginx Edge]
  NginxEdge -->|"No CORS headers<br/>(Nginx doesn't set CORS)"| Fastify[Fasty]
  Fastify -->|"Access-Control-Allow-Origin:<br/>https://staging.circle1.com"| NginxEdge
  NginxEdge -->|"Passes CORS headers<br/>unchanged"| Browser

  subgraph Important["⚠️ CORS is handled by Fastify, not Nginx"]
    direction TB
    Note["Nginx does NOT set or modify<br/>Access-Control-Allow-Origin.<br/>Fastify's @fastify/cors plugin<br/>handles CORS."]
  end
```

**Nginx does not interfere with CORS.** The `@fastify/cors` plugin in
Fastify handles all CORS headers. Nginx passes them through unchanged.

**What must be configured:**
- `ALLOWED_ORIGINS` in Fastify env — explicit HTTPS origins, no wildcards
- `BETTER_AUTH_TRUSTED_ORIGINS` — must match allowed origins

---

## Rate Limit Tuning

```mermaid
flowchart TD
  subgraph Edge["Nginx edge (current)"]
    EdgeGeneral["c1rcle_edge_general: 10r/s<br/>burst=20 nodelay"]
    EdgeAuth["c1rcle_edge_auth: 5r/s<br/>burst=10 nodelay"]
    EdgeConn["c1rcle_edge_connections: 100<br/>per-IP concurrent"]
  end

  subgraph App["Fastify application (current)"]
    AppRate["In-memory sliding window<br/>(plugins/rate-limit.ts)"]
  end

  subgraph Future["Future (Redis-backed)"]
    RedisRate["Redis rate limiting<br/>(shared across instances)"]
  end

  Edge -->|"First line of defense"| AppRate
  AppRate -->|"Second line of defense"| RedisRate

  style Edge fill:#e0f0ff
  style App fill:#fff0e0
  style Future fill:#ffe0e0
```

**Two layers of rate limiting exist:**
1. **Nginx edge:** IP-based, applies before request reaches Fastify
2. **Fastify application:** IP-based or user-based, applied in middleware

**Tuning guidance:**
- Start with Nginx limits as-is (10r/s general, 5r/s auth)
- Monitor 429 rates in Nginx logs after deployment
- Increase only if legitimate traffic is being blocked
- Auth limits should be stricter (login attempts are expensive)

---

## Environment Variable Checklist

### BFF (Next.js)

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `https://staging-api.circle1.com` | Points to Nginx, not Fastify directly |
| `NEXT_PUBLIC_BASE_URL` | `https://staging.circle1.com` | BFF's own public URL |
| `ALLOWED_ORIGINS` | `https://staging.circle1.com` | Browser origin for CORS |

### Fastify Gateway

| Variable | Value | Notes |
|---|---|---|
| `TRUSTED_PROXY_CIDRS` | (Nginx private IP) | Must match Nginx container's actual IP |
| `ALLOWED_ORIGINS` | `https://staging.circle1.com` | CORS origins |
| `BETTER_AUTH_URL` | `https://staging-api.circle1.com` | Public API URL for auth redirects |
| `PUBLIC_API_URL` | `https://staging-api.circle1.com` | Public API URL |
| `PORT` | `8080` | Private listener, not public |

### Nginx Edge

| Variable | Value | Notes |
|---|---|---|
| `NGINX_PROFILE` | `staging` | |
| `FASTIFY_UPSTREAM` | `circle-v2-backend-staging:8080` | Private service DNS |
| `NGINX_SERVER_NAME` | `staging-api.circle1.com` | Verified hostname |
| `NGINX_FORWARDED_PROTO` | `https` | Render terminates TLS externally |
| `NGINX_READINESS_TOKEN` | 32+ byte random secret | Required in `X-Readiness-Token` header to reach `/readiness`, `/version` |

---

## BFF-to-Nginx Fetch Calls

The BFF makes server-side HTTP requests to Nginx. These requests bypass
the browser entirely.

```mermaid
sequenceDiagram
    participant Browser
    participant BFF as Next.js BFF
    participant Nginx as Nginx Edge
    participant Fastify as Fastify Gateway

    Browser->>BFF: GET /api/app/tickets<br/>(CSRF cookie)
    Note over BFF: BFF validates CSRF<br/>Reads session cookie
    BFF->>Nginx: GET /api/v2/tickets<br/>Cookie: session=...<br/>X-Organization-Id: org_123
    Note over Nginx: Rate limit check<br/>Header washing<br/>Request-ID generation
    Nginx->>Fastify: GET /api/v2/tickets<br/>Cookie: session=...<br/>X-Organization-Id: org_123<br/>X-Request-Id: edge-uuid
    Note over Fastify: trustProxy validates peer<br/>Accepts X-Request-Id<br/>Better Auth validates session<br/>RBAC checks org scope
    Fastify-->>Nginx: 200 { tickets: [...] }
    Nginx-->>BFF: 200 { tickets: [...] }
    BFF-->>Browser: 200 { tickets: [...] }
```

**Important:** The BFF does NOT add `X-Request-Id` to its server-side
calls. Nginx generates one. The BFF's browser-facing request ID (if any)
is separate from the server-side Nginx request ID.

---

## Mobile App Integration

The mobile app calls Nginx directly (no BFF).

```mermaid
flowchart LR
  Mobile["Mobile App<br/>(Expo/RN)"] -->|"HTTPS<br/>Authorization: Bearer ..."| NginxEdge[Nginx Edge]
  NginxEdge -->|"proxy_pass"| Fastify[Fasty]

  subgraph MobileNotes["Mobile-specific notes"]
    Note1["Mobile app uses<br/>PUBLIC_API_URL env var"]
    Note2["No CSRF needed<br/>(Bearer token auth)"]
    Note3["Rate limiting applies<br/>per mobile device IP"]
  end
```

**Mobile-specific considerations:**
- Mobile uses `Authorization: Bearer` tokens, not cookies
- No CSRF protection needed (Bearer tokens are not auto-sent by browsers)
- Rate limiting applies per device IP (cellular IPs are shared — may need
  higher limits for mobile)
- `PUBLIC_API_URL` must point to Nginx, not Fastify directly

---

## Verification Commands

After deployment, verify the integration:

```bash
# Health check through Nginx
curl -s https://staging-api.circle1.com/api/v2/internal/health

# Verify request-ID is present in response
curl -sI https://staging-api.circle1.com/api/v2/internal/health | grep x-request-id

# Verify CORS headers
curl -sI -H "Origin: https://staging.circle1.com" \
  https://staging-api.circle1.com/api/v2/internal/health | grep access-control

# Verify smuggling headers are blanked
curl -s -H "X-User-Id: admin" \
  https://staging-api.circle1.com/api/v2/internal/version

# Verify rate limiting (should get 429 after burst)
for i in $(seq 1 25); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    https://staging-api.circle1.com/api/v2/tickets
done
```
