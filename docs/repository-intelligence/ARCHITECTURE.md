# Architecture

## Current

A Fastify API Gateway exposes versioned routes into core application services. Domain ports separate business logic from Firestore, memory repositories, payment providers, and email delivery.

## Authoritative boundaries

- Backend services and persistence are authoritative for money, entitlements, authorization decisions, and durable event/order state.
- Shared contracts are the compatibility boundary consumed by both repositories.
- Frontend route/UI state is not proof of backend persistence or provider behavior.
- Fixture sources are presentation/test evidence only until live callers are proven.

## Drift and target

Observed drift risk is strongest where UI states, fixture sources, shared contracts, and backend routes evolve in the same dirty working tree. The target architecture is contract-first, backend-authoritative, with explicit live/fixture/unavailable labels and staging evidence for each critical domain.

## Verified execution evidence

- buildApp() is the composition root for CORS, tracing, rate limiting, validation, RBAC decorators, caching, errors, readiness, route registration, and cleanup (apps/api-gateway/src/app.ts:39-78,148-251).
- One V2 manifest registers auth, public, partner, admin, checkout/payment/webhook, order/ticket/wallet, door/scanner, finance, support, social, and notification routes (apps/api-gateway/src/routes/v2/route-manifest.ts:69-183).
- createV2Services() centralizes service construction and STORAGE_DRIVER selects memory versus Firestore repositories (apps/api-gateway/src/lib/v2-services.ts:123-180; packages/core/src/infrastructure/utils.ts:121-139,195-226).
- Repository ports are storage-neutral and support transaction contexts (packages/core/src/domain/ports/repositories.ts:1-8,112-134).
- The Dockerfile explicitly runs the modular monolith as one Fastify process using the tsx loader; it does not compile the full graph (Dockerfile:5-14,57-63,84-98).
