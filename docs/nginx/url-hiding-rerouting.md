# URL Hiding and Rerouting

> **Last verified:** `69687f7` — 2026-09-09 — run `bash docs/nginx/regenerate.sh` to refresh

## Status: NOT Implemented

URL hiding (path rewriting, URL masking) is **not implemented**. Nginx proxies
`/api/v2/*` requests to Fastify as-is with no path transformation. The external
URL and internal URL are identical.

---

## Current Behavior: No Path Transformation

```mermaid
sequenceDiagram
    participant Client as Client
    participant Nginx as Nginx Edge
    participant Fastify as Fastify Gateway

    Client->>Nginx: GET /api/v2/tickets?page=1
    Note over Nginx: No rewrite applied
    Nginx->>Fastify: GET /api/v2/tickets?page=1<br/>(path unchanged)
    Fastify-->>Nginx: 200 { tickets: [...] }
    Nginx-->>Client: 200 { tickets: [...] }
```

**What the client sees:** `/api/v2/tickets?page=1`
**What Fastify receives:** `/api/v2/tickets?page=1`

There is no difference. The `/api/v2/` prefix is the real internal route.
Nginx does not strip, add, or transform it.

---

## What URL Hiding Would Look Like (Future)

If we wanted to hide the `/api/v2/` prefix from external URLs:

```mermaid
sequenceDiagram
    participant Client as Client
    participant Nginx as Nginx Edge
    participant Fastify as Fastify Gateway

    Client->>Nginx: GET /tickets?page=1<br/>(no /api/v2/ prefix)
    Note over Nginx: rewrite /tickets → /api/v2/tickets
    Nginx->>Fastify: GET /api/v2/tickets?page=1<br/>(rewritten path)
    Fastify-->>Nginx: 200 { tickets: [...] }
    Nginx-->>Client: 200 { tickets: [...] }
```

**This is NOT implemented.** The config would require:

```nginx
# NOT currently in the codebase — hypothetical
location ^~ /tickets {
    rewrite ^/tickets(.*)$ /api/v2/tickets$1 break;
    proxy_pass http://c1rcle_fastify;
}
```

---

## What URL Hiding Would Require

```mermaid
flowchart TD
  Goal["URL hiding: /tickets → /api/v2/tickets"] --> Changes["Config changes needed"]
  Changes --> C1["Add location blocks for each<br/>external path prefix"]
  Changes --> C2["Add rewrite rules mapping<br/>external → internal paths"]
  Changes --> C3["Update CORS origins<br/>to match new external paths"]
  Changes --> C4["Update BFF fetch calls<br/>to use new external paths"]
  Changes --> C5["Update mobile app API base URL<br/>to new external paths"]
  Changes --> C6["Update documentation<br/>and API contract definitions"]

  C1 --> Risk1["⚠️ Every new route needs a new<br/>location block — maintenance burden"]
  C2 --> Risk2["⚠️ rewrite rules are fragile<br/>break easily with query strings"]
  C3 --> Risk3["⚠️ CORS must cover all<br/>external path patterns"]
  C4 --> Risk4["⚠️ BFF and mobile app<br/>must change simultaneously"]
```

---

## Why Not Implemented

| Reason | Explanation |
|---|---|
| **No external API consumers yet** | The API is consumed by the BFF (server-side) and mobile app — both can use the full path |
| **Maintenance burden** | Every new route requires a matching Nginx location block |
| **Fragile rewrites** | `rewrite` directives break with edge cases (query strings, trailing slashes, encoded characters) |
| **BFF already abstracts** | The Next.js BFF already hides the backend from the browser — `/api/app/*` routes in the BFF call Fastify internally |
| **Security through obscurity** | Hiding the prefix provides no real security benefit; rate limiting and auth are the real protections |

---

## Current Location Matching Order

Nginx evaluates locations in this order. The path `/api/v2/` is always part
of the external URL:

```mermaid
flowchart TD
  Req["GET /api/v2/auth/login"] --> L1{"location = /api/v2/internal/health?"}
  L1 -->|No| L2{"location = /api/v2/internal/readiness?"}
  L2 -->|No| L3{"location = /api/v2/internal/version?"}
  L3 -->|No| L4{"location ^~ /api/v2/auth/ ?"}
  L4 -->|"✅ Match"| AuthRate["Auth rate limit zone<br/>5r/s, burst=10"]
  L4 -->|No| L5{"location ^~ /api/v2/ ?"}
  L5 -->|"✅ Match"| GeneralRate["General rate limit zone<br/>10r/s, burst=20"]
  L5 -->|No| NotFound["Nginx default 404"]
```

**Priority order:**
1. Exact match (`= /api/v2/internal/health`) — highest priority
2. Prefix with `^~` (`^~ /api/v2/auth/`) — no regex check after match
3. Prefix with `^~` (`^~ /api/v2/`) — catches remaining API routes
4. Default — Nginx 404

**No catch-all route exists.** Requests not matching `/api/v2/*` get Nginx's
default 404 response (not the structured JSON error format).

---

## Admin Routes Behind Nginx

The internal routes (`/api/v2/internal/*`) are behind Nginx but gated:

```mermaid
flowchart TD
  HealthReq["GET /api/v2/internal/health"] --> HealthCheck["Always accessible<br/>(no allowlist check)"]
  ReadinessReq["GET /api/v2/internal/readiness"] --> ReadinessCheck{"IP in<br/>NGINX_READINESS_ALLOWLIST?"}
  ReadinessCheck -->|Yes| ReadinessOK["Proxy to Fastify"]
  ReadinessCheck -->|No| Readiness404["404 Not Found"]
  VersionReq["GET /api/v2/internal/version"] --> VersionCheck{"IP in<br/>NGINX_READINESS_ALLOWLIST?"}
  VersionCheck -->|Yes| VersionOK["Proxy to Fastify"]
  VersionCheck -->|No| Version404["404 Not Found"]
```

**Key property:** Readiness and version endpoints are **gated by IP**, not just
path. This prevents deployment metadata from being publicly visible, even
though the path itself is known.

---

## Summary

| Feature | Status | Complexity |
|---|---|---|
| Path proxying (as-is) | ✅ Implemented | Trivial |
| URL hiding (prefix strip) | ❌ Not implemented | Medium — location blocks + rewrites + CORS + client changes |
| Path rewriting (transform) | ❌ Not implemented | High — fragile, maintenance-heavy |
| Admin route gating (IP) | ✅ Implemented | Low — geo map in templates |
| Catch-all error handling | ✅ Implemented | Low — error_page directives |
