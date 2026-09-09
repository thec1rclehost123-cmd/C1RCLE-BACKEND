# Load Balancing

> **Last verified:** `69687f7` — 2026-09-09 — run `bash docs/nginx/regenerate.sh` to refresh

## Status: NOT Implemented

Load balancing is **deliberately not enabled**. Nginx currently proxies to
a single Fastify upstream. This is a conscious engineering decision, not an
omission.

---

## Current State: Single Upstream

```nginx
# deploy/nginx/snippets/proxy-common.conf
proxy_next_upstream off;
```

```nginx
# deploy/nginx/conf.d/api.conf (local)
upstream c1rcle_fastify {
    server 127.0.0.1:8080;
    keepalive 32;
}
```

```mermaid
graph LR
  Nginx -->|"proxy_pass<br/>keepalive 32"| Fastify1["Fastify instance<br/>:8080"]
  Nginx -.-|"proxy_next_upstream off<br/>(NO fallback)"| X["❌ No second upstream"]
```

**What `proxy_next_upstream off` means:**
- If Fastify returns an error or times out, Nginx does **not** retry on
  another upstream
- The client receives the error directly (502/503/504 JSON from Nginx)
- This is the correct default for a gateway that handles mutations

---

## Why Deliberately Deferred

```mermaid
flowchart TD
  Goal["Enable load balancing<br/>multiple Fastify instances"] --> Prereq1{"Prerequisites met?"}
  Prereq1 -->|No| Block["⛔ Do not enable"]

  subgraph Required["Required before load balancing"]
    direction TB
    P1["Sticky sessions or<br/>distributed session store"]
    P2["Redis-backed rate limiting<br/>(replacing in-memory sliding window)"]
    P3["Order idempotency<br/>stored in Firestore, not in-memory"]
    P4["Health-check probing<br/>Nginx must know which upstreams are alive"]
    P5["Measured capacity data<br/>know when one instance is not enough"]
    P6["Render private network<br/>supports multiple private services"]
  end

  Prereq1 --> P1
  Prereq1 --> P2
  Prereq1 --> P3
  Prereq1 --> P4
  Prereq1 --> P5
  Prereq1 --> P6
```

### Specific Risks of Enabling Too Early

```mermaid
graph TD
  subgraph SessionProblem["Session Problem"]
    S1["Client A logs in → Fastify 1 creates session"]
    S2["Client A sends next request → Nginx routes to Fastify 2"]
    S3["Fastify 2 has no session → 401 Unauthorized"]
  end

  subgraph IdempotencyProblem["Idempotency Problem"]
    I1["POST /api/v2/orders sent → Fastify 1 creates order"]
    I2["Network timeout → Nginx retries → Fastify 2 creates DUPLICATE order"]
    I3["Client charged twice"]
  end

  subgraph RateLimitProblem["Rate Limit Problem"]
    R1["Fastify 1 tracks: 5 requests from IP X"]
    R2["Fastify 2 tracks: 0 requests from IP X"]
    R3["Client gets 10 requests/second instead of 5"]
  end
```

---

## What Would Change to Enable Load Balancing

### Current (single upstream)

```nginx
upstream c1rcle_fastify {
    server fastify-1:8080;
    keepalive 32;
}
```

### Target (multiple upstreams — NOT yet implemented)

```nginx
upstream c1rcle_fastify {
    # Round-robin is the default; least_conn is an option
    # least_conn;
    server fastify-1:8080;
    server fastify-2:8080;
    keepalive 32;
}
```

```mermaid
graph LR
  Nginx --> Fastify1["Fastify 1<br/>:8080"]
  Nginx --> Fastify2["Fastify 2<br/>:8080"]
  Nginx -.->|"least_conn or<br/>round-robin"| Decision["Load balancing algorithm"]
```

**Additional changes required:**
1. `proxy_next_upstream` must remain `off` for mutation routes (POST, PUT,
   PATCH, DELETE) — retries on mutations create duplicates
2. `proxy_next_upstream error timeout` could be safe for read-only routes
   (GET) only — but requires application-level idempotency proof first
3. Nginx `health` or `match` blocks needed to probe Fastify health and
   exclude unhealthy upstreams

---

## Readiness Probing (Planned)

```mermaid
sequenceDiagram
    participant Nginx
    participant Fastify1 as Fastify 1
    participant Fastify2 as Fastify 2

    loop Every 10s (proposed)
        Nginx->>Fastify1: GET /api/v2/internal/health
        Nginx->>Fastify2: GET /api/v2/internal/health
        Fastify1-->>Nginx: 200 OK
        Fastify2-->>Nginx: 503 Starting up
        Note over Nginx: Remove Fastify2 from pool<br/>until health returns 200
    end
```

**Not yet implemented.** The `/api/v2/internal/health` endpoint exists in
Fastify and is accessible through Nginx. But Nginx's passive health checks
(`max_fails`, `fail_timeout`) are not configured, and active health probes
(`health_check` directive) require Nginx Plus or a third-party module.

---

## Dependency Tree

```mermaid
graph TD
  LoadBalancing["Load balancing<br/>enabled"] --> Sessions["Sticky sessions<br/>or distributed session store"]
  LoadBalancing --> RedisRate["Redis-backed rate limiting"]
  LoadBalancing --> Idempotency["Idempotency key storage<br/>in Firestore"]
  LoadBalancing --> HealthProbe["Health-check probing"]
  LoadBalancing --> Capacity["Measured capacity data"]
  LoadBalancing --> MultiService["Multiple private services<br/>on Render"]

  Sessions --> Redis["Redis instance<br/>(REDIS_URL configured)"]
  RedisRate --> Redis
  Idempotency --> Firestore["Firestore<br/>(idempotency collection)"]
  HealthProbe --> HealthEndpoint["GET /api/v2/internal/health"]
  Capacity --> LoadTest["Load testing results"]
  MultiService --> RenderConfig["Render dashboard<br/>multiple private services"]

  style LoadBalancing fill:#fff0e0,stroke:#c90
  style Redis fill:#ffe0e0,stroke:#c33
  style Idempotency fill:#ffe0e0,stroke:#c33
  style HealthProbe fill:#ffe0e0,stroke:#c33
```

**Current status of each dependency:**

| Dependency | Status | What exists |
|---|---|---|
| Sticky sessions | ❌ Not implemented | Fastify uses in-memory sessions |
| Redis | ⚠️ Configured but unused | `REDIS_URL` in env, no active Redis client |
| Idempotency | ⚠️ In-memory only | `Idempotency-Key` header preserved by Nginx, but Fastify stores in-memory |
| Health probing | ⚠️ Endpoint exists, no probing | `/api/v2/internal/health` works, Nginx doesn't probe it |
| Capacity data | ❌ No load tests run | No production traffic data |
| Multiple services | ❌ Not configured on Render | Single `circle-v2-backend` service |

---

## Decision: When to Revisit

Enable load balancing when ALL of these are true:

1. **Measured traffic exceeds one Fastify instance capacity**
   - Run `deploy/staging/load-baseline.sh` against the staging environment
   - Confirm p99 latency > 500ms or CPU > 70% on a single instance

2. **Sessions are not in-memory**
   - Migrate to Redis-backed session store or JWT-only sessions
   - Verify session persistence across Fastify restarts

3. **Idempotency is Firestore-backed**
   - Move idempotency key storage from in-memory Map to Firestore
   - Verify duplicate prevention across instances

4. **Redis is proven in staging**
   - `REDIS_URL` is configured and a Redis instance is running
   - Rate limiting uses Redis instead of in-memory sliding window

5. **Render supports it**
   - Multiple private services can be created on the same private network
   - `FASTIFY_UPSTREAM` is updated to include multiple addresses (or use
     a service mesh/DNS round-robin)

**Do not enable load balancing based on assumption alone.** The default
single-upstream configuration is safe and correct for the current state
of the application.
