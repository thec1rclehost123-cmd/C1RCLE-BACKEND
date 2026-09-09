# Deployment Guide

> **Last verified:** `69687f7` — 2026-09-09 — run `bash docs/nginx/regenerate.sh` to refresh

This document covers how to deploy the two-service Nginx + Fastify topology
on Render, and how to validate it locally before pushing.

---

## Render Two-Service Topology

```mermaid
graph TB
  subgraph Render["Render Platform (Singapore)"]
    subgraph PublicWeb["Web Service: circle-v2-edge-staging"]
      NginxContainer["Nginx container<br/>Dockerfile.nginx<br/>nginx:1.27-alpine<br/>Listen: 0.0.0.0:$PORT<br/>Public: yes"]
    end

    subgraph PrivateNet["Private Network"]
      FastifyContainer["Private Service: circle-v2-backend-staging<br/>Dockerfile<br/>node:24-slim<br/>Listen: 0.0.0.0:8080<br/>Public: no"]
    end

    RenderTLS["Render TLS termination<br/>(platform-owned certificate)"]
  end

  Browser[Browser] -->|HTTPS| RenderTLS
  RenderTLS -->|"HTTP via Render<br/>internal proxy"| NginxContainer
  NginxContainer -->|"HTTP :8080<br/>service DNS"| FastifyContainer
  FastifyContainer --> Firestore[(Firestore)]
  FastifyContainer --> Storage[(Firebase Storage)]

  style PublicWeb fill:#e0f0ff,stroke:#36a
  style PrivateNet fill:#f0f0ff,stroke:#36a
```

### Service Comparison

| Setting | Nginx Edge (Public) | Fastify Backend (Private) |
|---|---|---|
| **Render name** | `circle-v2-edge-staging` | `circle-v2-backend-staging` |
| **Type** | Web Service | Private Service |
| **Runtime** | Docker | Docker |
| **Dockerfile** | `deploy/docker/Dockerfile.nginx` | `./Dockerfile` |
| **Build context** | Repository root | Repository root |
| **Region** | Singapore | Singapore |
| **Public exposure** | Yes | None |
| **Listener** | `0.0.0.0:$PORT` (Render-injected) | `0.0.0.0:8080` |
| **Health check** | `/api/v2/internal/health` | TCP check only |
| **TLS** | Render-owned | None (private HTTP) |

---

## Environment Variables

### Nginx Edge Service

| Variable | Value | Source |
|---|---|---|
| `NGINX_PROFILE` | `staging` | Dashboard |
| `FASTIFY_UPSTREAM` | `circle-v2-backend-staging:8080` | Dashboard (private DNS) |
| `NGINX_HTTP_PORT` | (omit — Render injects `PORT`) | Render platform |
| `NGINX_SERVER_NAME` | `staging-api.circle1.com` | Dashboard |
| `NGINX_FORWARDED_PROTO` | `https` | Dashboard |
| `NGINX_READINESS_ALLOWLIST_LINES` | `10.0.0.0/8 1;` (actual CIDRs) | Dashboard |

### Fastify Backend Service

| Variable | Value | Source |
|---|---|---|
| `NODE_ENV` | `staging` | Dashboard |
| `PORT` | `8080` | Dashboard |
| `HOST` | `0.0.0.0` | Dashboard |
| `STORAGE_DRIVER` | `firestore` | Dashboard |
| `FIRESTORE_PROJECT_ID` | (secret) | Dashboard |
| `FIREBASE_CLIENT_EMAIL` | (secret) | Dashboard |
| `FIREBASE_PRIVATE_KEY` | (secret) | Dashboard |
| `FIREBASE_STORAGE_BUCKET` | (secret) | Dashboard |
| `BETTER_AUTH_SECRET` | (secret) | Dashboard |
| `BETTER_AUTH_URL` | `https://staging-api.circle1.com` | Dashboard |
| `PUBLIC_API_URL` | `https://staging-api.circle1.com` | Dashboard |
| `ALLOWED_ORIGINS` | `https://staging.circle1.com` | Dashboard |
| `TRUSTED_PROXY_CIDRS` | (Nginx private IP range) | Dashboard |
| `LOG_LEVEL` | `info` | Dashboard |

---

## Step-by-Step Deployment

```mermaid
flowchart TD
  Step1["1. Validate environment<br/>node deploy/staging/validate-environment.mjs"]
  Step2["2. Render nginx config<br/>node deploy/staging/render-nginx.mjs --output rendered.conf"]
  Step3["3. Run preflight checks<br/>deploy/staging/preflight-staging.sh"]
  Step4["4. Create Render services<br/>(Nginx web + Fastify private)"]
  Step5["5. Configure env vars<br/>(dashboard or env group)"]
  Step6["6. Deploy both services<br/>(same commit/branch)"]
  Step7["7. Run smoke tests<br/>deploy/staging/smoke-staging.sh"]
  Step8["8. Run security tests<br/>deploy/staging/security-tests.sh"]
  Step9["9. Run load baseline<br/>deploy/staging/load-baseline.sh"]
  Step10["10. Monitor for 24 hours<br/>(latency, error rate, logs)"]

  Step1 --> Step2 --> Step3 --> Step4 --> Step5 --> Step6 --> Step7 --> Step8 --> Step9 --> Step10

  style Step1 fill:#e0ffe0
  style Step7 fill:#e0ffe0
  style Step8 fill:#e0ffe0
  style Step10 fill:#fff0e0
```

### Step 1: Validate Environment

```bash
node deploy/staging/validate-environment.mjs
```

This checks:
- All required env vars are set
- No development defaults in staging values
- No CIDR `/0` (unrestricted trust)
- No localhost or example values
- Port numbers are valid integers
- `FASTIFY_UPSTREAM` has no scheme or path

### Step 2: Render Nginx Config

```bash
node deploy/staging/render-nginx.mjs --output rendered.conf
```

Renders `staging.conf.template` with `envsubst` using the validated values.
Preserve `rendered.conf` as a deployment artifact.

### Step 3: Run Preflight Checks

```bash
deploy/staging/preflight-staging.sh
```

Checks:
- Environment validation
- Config render is clean (no unresolved `${}` placeholders)
- DNS resolution for `NGINX_SERVER_NAME`
- Direct Fastify health check (bypassing Nginx)
- Public health check through Nginx
- Readiness endpoint from allowed CIDR

### Step 4: Create Render Services

1. **Fastify (Private Service):**
   - Dashboard → New → Private Service
   - Dockerfile: `./Dockerfile`
   - Branch: staging
   - Region: Singapore
   - No public port

2. **Nginx (Web Service):**
   - Dashboard → New → Web Service
   - Dockerfile: `deploy/docker/Dockerfile.nginx`
   - Branch: staging
   - Region: Singapore
   - Health check path: `/api/v2/internal/health`

### Step 5: Configure Environment

Set all env vars in each service's dashboard. Use Render env groups if
managing multiple environments.

### Step 6: Deploy

Push to the staging branch. Both services auto-deploy if `autoDeploy` is
enabled. Ensure both are on the **same commit**.

### Step 7: Run Smoke Tests

```bash
deploy/staging/smoke-staging.sh
```

Ordered functional checks:
- Health endpoint returns 200
- Readiness endpoint returns 200 (from allowed CIDR)
- Version endpoint returns commit info
- Auth rate limiting returns 429 after burst
- General API routing works through Nginx

### Step 8: Run Security Tests

```bash
deploy/staging/security-tests.sh
```

Checks:
- Host allowlisting (unknown host → 444)
- Readiness from disallowed IP → 404
- Security headers present (nosniff, no-referrer, no-store)
- Smuggling headers blanked (X-User-Id, True-Client-IP, etc.)
- Body size limit (413 on > 1m)
- TLS behavior (if nginx TLS mode)

### Step 9: Run Load Baseline

```bash
deploy/staging/load-baseline.sh --duration 60 --rps 50
```

Measures p50/p95/p99 latency under load. Start conservative and increase
gradually.

### Step 10: Monitor

Watch for 24 hours:
- Latency percentiles (should not regress)
- Error rate (502/503/504 from Nginx edge)
- Nginx access logs (JSON format)
- Fastify application logs
- Certificate expiry (if Nginx-owned TLS)

---

## Local Validation

Before pushing to Render, validate locally:

```bash
# Option 1: Host-process validation
bash deploy/nginx/tests/run-local-validation.sh

# Option 2: Docker container validation
bash deploy/staging/tests/run-container-integration.sh
```

### Host-Process Validation

```mermaid
flowchart LR
  HostNginx["Host Nginx<br/>:8081"] --> HostFastify["Host Fastify<br/>:8080"]
  TestScript["run-local-validation.sh"] --> HostNginx
  TestScript --> HostFastify
```

- Requires Nginx installed on host
- Requires Fastify running on `:8080`
- Tests config syntax, proxy behavior, request-ID, rate limits

### Container Integration

```mermaid
flowchart LR
  subgraph DockerNet["Private Docker Network"]
    NginxCont["Nginx container<br/>:8080 (public)"] --> FastifyCont["Fastify container<br/>:8080 (private)"]
  end
  TestScript["run-container-integration.sh"] --> NginxCont
  TestScript --> FastifyCont
```

- Builds both Docker images
- Creates isolated private network
- Fastify is NOT host-mapped (only reachable through Nginx)
- Tests real container topology

---

## Rollback Procedure

If staging breaks:

```mermaid
flowchart TD
  Issue["Issue detected"] --> Decision{"Root cause?"}
  Decision -->|"Nginx config"| RollbackNginx["Rollback Nginx service<br/>to previous deploy"]
  Decision -->|"Fastify code"| RollbackFastify["Rollback Fastify service<br/>to previous deploy"]
  Decision -->|"Both"| RollbackBoth["Rollback both services<br/>to previous commit"]
  Decision -->|"Environment var"| FixEnv["Fix env var in dashboard<br/>no redeploy needed"]

  RollbackNginx --> Verify["Verify /api/v2/internal/health"]
  RollbackFastify --> Verify
  RollbackBoth --> Verify
  FixEnv --> Verify
```

**Render rollback:** Dashboard → Service → Events → click "Rollback" on
the last successful deploy.

**Do not** rollback one service without the other if the commit included
changes to both. Both must be on compatible versions.
