# Reverse Proxy

> **Last verified:** `69687f7` — 2026-09-09 — run `bash docs/nginx/regenerate.sh` to refresh

This document covers how Nginx acts as a reverse proxy for the Fastify gateway:
header forwarding, smuggling prevention, request-ID generation, and the
proxy-common.conf configuration.

---

## Header Forwarding Model

Nginx uses a **clean-slate** approach: every identity header is overwritten
from a known-good source. Client-supplied identity headers are never trusted.

```mermaid
flowchart TD
  subgraph Client["Client sends"]
    CH[Host, X-Forwarded-For,<br/>X-User-Id, True-Client-IP,<br/>CF-Connecting-IP, Authorization,<br/>Cookie, X-Organization-Id, etc.]
  end

  subgraph NginxProcessing["Nginx proxy-common.conf processing"]
    direction TB
    Step1["Step 1: OVERWRITE identity headers<br/>Host → $host<br/>X-Forwarded-For → $remote_addr<br/>X-Forwarded-Proto → $c1rcle_forwarded_proto<br/>X-Real-IP → $remote_addr<br/>X-Forwarded-Host → $host"]
    Step2["Step 2: SET edge-generated values<br/>X-Request-Id → $request_id"]
    Step3["Step 3: PRESERVE application headers<br/>Authorization, Cookie, X-Organization-Id,<br/>Idempotency-Key, If-Match,<br/>X-Client-Request-Id, Content-Type, Content-Length"]
    Step4["Step 4: BLANK spoofable headers<br/>X-User-Id → ''<br/>X-Forwarded-Server → ''<br/>X-Forwarded-Port → ''<br/>X-Forwarded-Ssl → ''<br/>Forwarded → ''<br/>X-Original-* → ''<br/>X-Client-IP → ''<br/>True-Client-IP → ''<br/>CF-Connecting-IP → ''"]
  end

  subgraph Fastify["Fastify receives"]
    FH["Host: api.circle1.com"]
    FXFF["X-Forwarded-For: 127.0.0.1"]
    FXProto["X-Forwarded-Proto: https"]
    FXReqId["X-Request-Id: edge-uuid"]
    FAuth["Authorization: Bearer ..."]
    FCookie["Cookie: ..."]
    FOrg["X-Organization-Id: ..."]
    FEmpty["X-User-Id, True-Client-IP = ''"]
  end

  Client --> NginxProcessing --> Fastify

  style Step4 fill:#ffe0e0,stroke:#c33
  style Step2 fill:#e0e0ff,stroke:#36a
  style Step3 fill:#e0ffe0,stroke:#3a3
```

---

## HTTP Version and Connection Handling

```nginx
proxy_http_version 1.1;
proxy_set_header Connection "";
```

Nginx uses **HTTP/1.1** to the upstream and clears the `Connection` header
to enable keepalive. The `keepalive 32` directive on the upstream block
maintains a pool of 32 idle connections to Fastify, avoiding TCP handshake
overhead on every request.

```mermaid
graph LR
  Nginx -->|"HTTP/1.1<br/>keepalive on"| Fastify
  Nginx -->|"Connection: ''<br/>(cleared)"| Fastify

  subgraph Pool["keepalive 32 pool"]
    direction LR
    Conn1[conn 1] -.- Conn2[conn 2] -.- ConnN[conn 32]
  end

  Nginx -.-> Pool
  Pool -.-> Fastify
```

---

## Proxy Buffering and Caching

```nginx
proxy_request_buffering on;
proxy_buffering on;
proxy_cache off;
proxy_no_cache 1;
proxy_cache_bypass 1;
proxy_hide_header Cache-Control;
```

```mermaid
flowchart TD
  Req[Client request body] --> Buffer["proxy_request_buffering on<br/>Buffer entire body before forwarding"]
  Buffer --> Upstream[To Fastify]

  Response[Fastify response] --> RespBuffer["proxy_buffering on<br/>Buffer response before sending to client"]
  RespBuffer --> CacheDecision{"proxy_cache off<br/>proxy_no_cache 1<br/>proxy_cache_bypass 1"}
  CacheDecision -->|"Always bypass"| Direct[Send directly to client]
  RespBuffer --> HideCache["proxy_hide_header Cache-Control<br/>Remove upstream Cache-Control"]
  HideCache --> Direct

  style CacheDecision fill:#fff0e0,stroke:#c90
```

**Why this matters:**
- `proxy_request_buffering on`: Nginx reads the full request body before
  forwarding — prevents slow-client attacks
- `proxy_cache off` + `proxy_no_cache 1`: Nginx never caches API responses;
  application-level caching is Fastify's responsibility
- `proxy_hide_header Cache-Control`: Strips Fastify's Cache-Control before it
  reaches the client; the edge adds its own `Cache-Control: no-store` on
  error responses

---

## Timeouts

| Directive | Value | Purpose |
|---|---|---|
| `proxy_connect_timeout` | 5s | Max time to establish TCP connection to Fastify |
| `proxy_send_timeout` | 30s | Max time to send request body to Fastify |
| `proxy_read_timeout` | 30s | Max time to wait for Fastify response |
| `client_header_timeout` | 10s | Max time to receive request headers from client |
| `client_body_timeout` | 15s | Max time between body chunks from client |
| `send_timeout` | 30s | Max time to send response to client |
| `keepalive_timeout` | 65s | Idle keepalive connection timeout |

```mermaid
sequenceDiagram
    participant Client
    participant Nginx
    participant Fastify

    Client-->>Nginx: headers (must arrive within 10s)
    Client-->>Nginx: body chunks (gap ≤ 15s)
    Note over Nginx: Connect to Fastify (≤ 5s)
    Nginx->>Fastify: Send request (≤ 30s)
    Note over Fastify: Process request
    Fastify-->>Nginx: Response (within 30s read timeout)
    Nginx-->>Client: Response (≤ 30s send timeout)
```

---

## Rate Limiting at the Edge

Rate limits are applied at the Nginx level, before traffic reaches Fastify.
This protects the application from burst traffic and slow-client attacks.

```mermaid
flowchart TD
  Request[Incoming request] --> ZoneCheck{Rate limit zone?}
  ZoneCheck -->|"/api/v2/auth/*"| AuthZone["c1rcle_edge_auth<br/>5 requests/second<br/>burst=10 nodelay"]
  ZoneCheck -->|"/api/v2/* (other)"| GeneralZone["c1rcle_edge_general<br/>10 requests/second<br/>burst=20 nodelay"]
  ZoneCheck -->|"/api/v2/internal/*"| NoLimit["No rate limit<br/>(exact match, higher priority)"]

  AuthZone -->|Within limit| Pass["proxy_pass → Fastify"]
  AuthZone -->|Exceeded| Reject429["429 Too Many Requests<br/>JSON body + Retry-After: 1"]
  GeneralZone -->|Within limit| Pass
  GeneralZone -->|Exceeded| Reject429
  NoLimit --> Pass

  style Reject429 fill:#ffe0e0,stroke:#c33
  style AuthZone fill:#ffe0e0,stroke:#f66
  style GeneralZone fill:#fff0e0,stroke:#c90
```

**Connection limit:** `limit_conn c1rcle_edge_connections 100` — max 100
concurrent connections per client IP.

**Key properties:**
- Rate keys are `$binary_remote_addr` (socket peer IP)
- `nodelay` means burst requests are served immediately, not queued
- These are **edge protections**, not business quotas or per-user limits
- Tune with measured traffic before production rollout

---

## Keepalive Configuration

```nginx
upstream c1rcle_fastify {
    server 127.0.0.1:8080;  # or ${FASTIFY_UPSTREAM} in templates
    keepalive 32;
}
```

```mermaid
graph LR
  Nginx -->|"Connection: ''<br/>HTTP/1.1"| Fastify

  subgraph Pool["Keepalive pool: 32 connections"]
    C1[conn 1] --- C2[conn 2] --- C3[...] --- C32[conn 32]
  end

  Nginx -.->|"Reuse idle connections"| Pool
  Pool -.->|"Warm connections<br/>(no TCP handshake)"| Fastify
```

**Why 32:** Conservative starting point for one Fastify instance. Increase
only when measured concurrency justifies it. Each idle connection consumes
a file descriptor and a small amount of memory on both sides.

---

## Request Body Handling

```mermaid
flowchart TD
  Client[Client] -->|"POST /api/v2/orders<br/>Content-Length: 500KB"| Nginx
  Nginx --> SizeCheck{"Body size > 1m?"}
  SizeCheck -->|"Yes"| Reject413["413 edge_request_too_large<br/>JSON response"]
  SizeCheck -->|"No"| Buffer["proxy_request_buffering on<br/>Read entire body"]
  Buffer --> Forward["Forward to Fastify<br/>with original Content-Type,<br/>Content-Length preserved"]
  Forward --> Fastify[Fastify]

  style Reject413 fill:#ffe0e0,stroke:#c33
```

- `client_max_body_size 1m` — hard limit at the edge
- Request body is buffered before forwarding (prevents slow-client attacks)
- `Content-Type` and `Content-Length` are forwarded to Fastify
- No streaming/chunked transfer to the upstream

---

## proxy_redirect and proxy_pass

```nginx
proxy_redirect off;
proxy_pass http://c1rcle_fastify;
```

- `proxy_redirect off`: Nginx does not rewrite `Location` headers in
  Fastify responses — the gateway is responsible for its own redirects
- `proxy_pass http://c1rcle_fastify`: Proxies to the upstream block defined
  in the server block or template

---

## Edge Error Generation

When Nginx cannot reach Fastify or Fastify returns an error status, Nginx
generates structured JSON responses. These are defined in
`deploy/nginx/snippets/api-locations.conf`.

```mermaid
flowchart TD
  ProxyPass[proxy_pass → Fastify] --> UpstreamCheck{Upstream reachable?}
  UpstreamCheck -->|No| E502["502 edge_upstream_unavailable"]
  UpstreamCheck -->|Yes| ResponseCheck{Response status?}
  ResponseCheck -->|503| E503["503 edge_upstream_unavailable"]
  ResponseCheck -->|504 (timeout)| E504["504 edge_upstream_timeout"]
  ResponseCheck -->|2xx/4xx| Success[Pass to client]

  BodyCheck{Client body > 1m?} -->|Yes| E413["413 edge_request_too_large"]
  RateCheck{Rate limit exceeded?} -->|Yes| E429["429 edge_rate_limited"]

  E502 --> JSONResp["{<br/>  status: 502,<br/>  code: 'edge_upstream_unavailable',<br/>  message: '...',<br/>  requestId: '$request_id'<br/>}"]
  E503 --> JSONResp
  E504 --> JSONResp
  E413 --> JSONResp
  E429 --> JSONResp

  style JSONResp fill:#ffe0e0,stroke:#c33
```

All edge errors include:
- `X-Request-Id` header
- `Cache-Control: no-store` (via security-headers.conf)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
