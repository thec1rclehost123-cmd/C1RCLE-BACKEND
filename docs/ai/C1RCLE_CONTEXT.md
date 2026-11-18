# C1RCLE context

This is the starting map for work across C1RCLE. C1RCLE-BACKEND owns it alongside its cross-system architecture, API contracts, checkout flows and staging runbooks. The architecture map was last reviewed on November 17, 2026.

The separate C1RCLE acceptance-state ledger is the designated home for exact deployed revisions, acceptance evidence, PASS/FAIL by revision and current defects. Use that ledger to determine current acceptance.

## Product and applications

C1RCLE connects nightlife organizers, venues, promoters, guests and door teams. A Host or Venue prepares an event and publishes it through the applicable scheduling flow. A Promoter can distribute an eligible event under a relationship or assignment, with tracked attribution. A Guest discovers an event and claims or buys admission. At the door, authorized staff validate the admission against the event. Admins handle platform-wide operational work through a separate console.

| Surface | Frontend location | Responsibilities |
| --- | --- | --- |
| Guest Portal | `apps/guest-portal` | Public event discovery and details, Guest auth and onboarding, saved events and profile, RSVP or paid checkout, order confirmation and ticket wallet. Start in `src/app` for routes and `src/features` for domain-facing UI. |
| Partner Dashboard | `apps/partner-dashboard` | Role-based Host, Venue and Promoter studios. Host manages owned events and requests Venue time. Venue manages availability, requests and its own events, with a distinct operational view of associated events. Promoter manages relationships, event assignments, tracked links and attributed activity. Start with `src/app/partner/[studio]` and `src/components/partner-v3`. |
| Admin Console | `apps/admin-console` | Internal operator workflows for organization onboarding and KYC, orders and tickets, support and financial operations. Sensitive actions use scoped admin permissions and, where required, proposal and approval workflows. |
| Scanner | `apps/scanner-app` | Expo / React Native app for event-scoped door work, including staff/device pairing, ticket validation and check-in. The staging delivery path is an Expo web build. Native distribution is a later step in the Scanner deployment runbook. |

## Repository and request map

**C1RCLE-FRONTEND** is a TypeScript pnpm/Turborepo workspace. Guest, Partner and Admin use Next.js App Router. Shared code lives in `packages/`. Start with `api-client` for typed HTTP, `contracts` for shared schemas, `auth` and `providers` for shared identity/session integration, and `design-system`, `ui` and `icons` for presentation. Applications consume package public exports. Shared packages stay independent of apps. Next server routes and proxies are part of the web integration surface. Guest auth and checkout in particular go through app-local server routes. Scanner uses the Gateway directly with bearer and scanner session credentials where required.

**C1RCLE-BACKEND** is a TypeScript pnpm/Turborepo workspace with a Fastify modular monolith. `apps/api-gateway/src/routes/v2/route-manifest.ts` anchors the HTTP surface. Gateway routes parse requests, resolve identity and context, apply policy and call Core. Start with `apps/api-gateway/src/routes/v2` for route shapes and `apps/api-gateway/src/plugins/auth.ts` for authentication. `packages/core/src/application` holds use-case orchestration by domain. `packages/core/src/domain` holds models, invariants and repository ports. `packages/core/src/infrastructure/firestore` and `packages/core/src/infrastructure/memory` implement persistence behind those ports. The Core layer covers events, Venue scheduling, organizations, orders, ticket access, payments and finance, door and analytics.

For wire changes, start with the backend route, its service and the relevant schema under `packages/contracts/src/contracts`. Both repos have a `packages/contracts` workspace. The backend exports generated contract artifacts for the frontend, and cross-repo parity checks detect drift. Inspect both sides when changing a request, response, enum or error behavior. Product truth such as eligibility, inventory, payment and ownership belongs in the backend. Frontends consume server results and handle interaction, display and recovery. Product records are accessed through Gateway and Core, with scoped direct uploads via signed URLs where applicable.

## Roles, ownership and authorization

- **Host.** Can create and own events as an organization. Private event details and owner controls require authorization in the owning organization. A different Host cannot read or edit private event data by supplying its ID.
- **Venue.** Can own its own events and manage its schedule. A Host-owned event can also take place at that Venue. The Venue receives an association-scoped operational view, such as scheduling, event status, permitted attendance or door metrics and actions. Host edit/publish controls and Host commercial data remain scoped to the Host. Association alone confers no access to Host sales, revenue, settlements or payout records.
- **Promoter.** Distributes events through eligible relationships, agreements and event assignments. Tracked links carry attribution into the sale flow. The Promoter can see its assigned work and its own permitted performance or commission data. Event management and other organizations' financial data remain separately scoped. A Promoter's network-facing profile exposes limited performance information.
- **Guest.** The authenticated Guest can hold inventory, RSVP, purchase admission and see orders or tickets authorized to their identity. Order access follows the purchaser and the API's ownership checks. Ticket access and QR issuance follow the current entitlement or holder rules, including supported transfer flows. Guest A cannot fetch Guest B's order, ticket or QR by guessing an identifier.
- **Admin and Door operators.** Admin permissions authorize specific platform duties, with audit and approval requirements for sensitive operations. Door staff operate within assigned event/session permissions. An event code, device pairing or door role grants the applicable door operations and leaves organizer ownership and finance permissions separate.

For Partner requests, the selected organization is a caller-provided scope that the Gateway verifies against authenticated membership, capabilities and the operation. Services must also enforce the resource relationship and return the appropriate projection. Filtering a response or hiding a control in the UI is only presentation. Check both reads and writes when adding scope, especially for Venue views of Host events, search and analytics, ticket access and door operations.

## Events, Venue availability and slots

Keep organizer ownership, physical location and event lifecycle distinct. A Venue-owned event can be scheduled by that Venue. A Host-owned event at a partner Venue can be tied to a Venue availability window through a slot request. Availability describes bookable or blocked time and feeds the calendar and event editor. An external location is also supported where enabled and follows its own path.

A Host selects available time and submits a pending request. The Venue reviews and can accept or reject. The Host can withdraw an eligible outgoing request, represented as cancellation in the contract. A pending request reserves its selected slot against competing requests, acceptance books it and rejection or withdrawal releases it under the scheduling rules. The accepted Host event can appear in Venue operational reads and door workflows with the Host still recorded as organizer. Event publication and sales have their own lifecycle. Check both the request and the event when reasoning about what is visible to Guests or actionable by staff.

## Tickets, orders and payments

An event offers ticket tiers. A tier has a base price, availability and inventory limits. Where configured, a time-bounded pricing phase can supply the current price while its inventory is available. Event cards can show a backend-derived current minimum sellable price. The Guest quote is the authoritative breakdown for the specific selection, including applicable fees and discounts. The backend validates the selected quantities and phase inventory at checkout and reserves capacity with an expiring hold. If pricing changes between quote and hold, checkout asks for confirmation of the new total.

The hold is a reservation. The order tracks a Guest transaction and its financial and fulfillment state. A ticket or entitlement records admission and its holder. An admission QR is a credential for validating that entitlement at the door. A paid order can still be processing if fulfillment has yet to finish. Free RSVP has a direct backend fulfillment path without a provider payment. Payment, inventory and admission rules apply on the server across those paths.

For a paid booking, the Guest gets a quote and creates a hold. The Gateway creates a Razorpay payment attempt and provider order for that hold. The browser opens Razorpay Checkout with client-safe options and sends the result to the backend verification path. Razorpay can also notify the backend through its signed webhook. The backend checks provider evidence such as capture, amount and binding to the attempt before recording a paid order and fulfilling entitlements. Verification and provider handling must converge safely under retries. The wallet and confirmation UI read backend order and entitlement state. A provider success message alone is insufficient to grant admission.

**Razorpay Test Mode is the staging acceptance configuration.** The staging runbook describes the required provider and webhook binding. Successful provider-backed acceptance requires evidence for the tested revision and journey, including confirmation and wallet issuance.

## Infrastructure, environments and time

- **Firebase / Google Cloud.** Firestore holds domain records and read models through backend repositories. Firebase-backed object storage supports media via signed upload URLs. Firestore rules and indexes are tracked in the backend repo.
- **Vercel and Render.** Vercel hosts the Next.js apps and is configured for the Scanner web build. Render runs the Dockerized Gateway with its nginx sidecar under the staging deployment workflow. A Vercel environment label of “Production” can refer to a project whose configured branch is `staging`. Verify actual branch, SHA, target and provider mode before using a deployment as evidence.
- **Razorpay and Resend.** Razorpay provides payments and webhook events. Resend provides application email, including auth or notification mail where wired. Provider configuration and worker readiness can vary by environment.
- **Local, staging and production.** Local runs can use memory adapters or the emulator as appropriate. Connected tests need the approved environment and fixtures. Staging is the shared hosted integration and acceptance environment. Production is the live release boundary and requires explicit owner authorization. See the staging environment contract for documented origins and provider settings.
- **Partner operational time.** Use IST (`Asia/Kolkata`, UTC+05:30) for Partner business dates and times in scheduling, availability and event views. The shared `PRODUCT_TIME_ZONE` contract is used by calendar and event editor code. Keep timestamps as instants at the API boundary and use the product zone when deriving or displaying operational dates. The browser or CI machine zone must not determine the Partner business date.

Credentials and secrets are supplied separately through approved environment/secret mechanisms.

## Current product status

| Area | Staging baseline and acceptance status |
| --- | --- |
| Guest | Discovery, event details, RSVP, paid checkout and ticket wallet are implemented. M1–M3 cover sale and session behavior, auth and onboarding gating, and server-authoritative pricing. M1–M3 are implemented and substantially hosted-tested. Bounded regression remediation and targeted re-acceptance remain before the baseline is closed. |
| Partner | M1/M2 are implemented and deployed to staging, including the Venue-centric operational model in M2. Comprehensive hosted acceptance is pending. Owner-observed issues with selecting partnered Venue availability in Host Create Event and with Venue slot-request Accept/Decline require investigation before M3. |
| Promoter | A connected studio, relationship and agreement flows, event assignment, referral links and attribution are implemented. Complete hosted evidence across assignment, a real Test Mode attributed order and financial reconciliation remains pending. The dedicated Promoter Pass is future work. |
| Scanner | Door APIs and Scanner app flows for pairing, validation and check-in are implemented. The staging web deployment, role changes and first-login password setup are represented in the current baseline. Full hosted shift and device acceptance and native rollout remain pending. |
| Admin | The console and backend operator capabilities are implemented for key desks, including onboarding/KYC, orders, support and approvals. Prior hosted observations cover individual reads and workflows. Complete current hosted acceptance for operator permissions, sensitive actions and cross-system outcomes remains pending. |

## Locked pre-launch sequence

1. Finish current Guest remediation.
2. Run the comprehensive Guest and Partner hosted audits.
3. Rebuild remaining scope into exactly **three Guest and three Partner milestones**.
4. Implement those six milestones.
5. Run the Access & Tickets Pass.
6. Run the Promoter Pass.
7. Run the Scanner / Door Pass.
8. Run full cross-system hosted acceptance.
9. Run the Experience Quality Pass.
10. Implement approved Experience Quality fixes.
11. Run final adversarial launch acceptance.
12. Fix launch blockers only.
13. Prepare the Release Candidate, verify production readiness and launch with owner approval.

After the roadmap rebuild, freeze major new feature scope unless it is genuinely launch-critical.

The future **Access & Tickets Pass** covers normal tickets, Guestlists, Free-before-X, Profiling / Request Access and custom forms, Approve / Waitlist / Decline, approved free claims, approved paid access, approved guestlist, invitations and private access, claim links, promoter attribution and optional promoter caps. This is planned pass scope. Existing ticketing and access behavior should be assessed separately against the current implementation. Table design is deferred to separate work.

## Working practices

Preserve approved milestone scope and batch related fixes inside it. Use an isolated clean worktree from the correct baseline and preserve unrelated dirty checkouts. Where the backend supplies the contract, start there and verify parity with the consuming apps. Run focused checks as changes land, then one comprehensive final gate on the intended diff. Tie hosted acceptance to the app and API revisions, environment and actual journey exercised. Local tests and smoke checks answer narrower questions. Merges and deploys require owner authorization.

## Where to look next

Paths marked **Frontend** are in C1RCLE-FRONTEND. The hosted evidence ledgers are local workspace artifacts outside both repositories.

- **Architecture and decisions** — [backend architecture](../architecture/README.md) and [decision log](../architecture/decisions.md). For package layering, **Frontend** `docs/architecture/README.md`. Read current code for details that have drifted since these docs were written.
- **Status and acceptance** — [backend phase roadmap](../roadmap/ROADMAP.md), [staging checklist](../operations/staging-checklist.md) and [payments release gate](../operations/payments-release-gate.md). **Frontend** `LOCAL_PRODUCT_ACCEPTANCE_2026-11-13.md` records scoped local evidence. For prior hosted results use the workspace ledgers `C1RCLE-HOSTED-ACCEPTANCE-20261111/ACCEPTANCE.md` and `C1RCLE-PUBLISHING-HOSTED-VERIFICATION-20261116/HOSTED-VERIFICATION.md` under the Desktop.
- **Product policy** — **Frontend** `docs/M4_COMMERCIAL_POLICY_DECISION.md` and `docs/M4_PROMOTER_ATTRIBUTION_MODEL.md` for commercial policy and attribution. For current Venue scheduling and event visibility, read backend `packages/core/src/application/venues/venue-service.ts` and `packages/core/src/application/events/event-service.ts`.
- **Contracts and auth** — [auth and permissions](../api-contracts/auth-and-permissions.md), [checkout sequence](../integration-flows/checkout.md) and backend `packages/contracts/src/contracts`. Cross-check the live route manifest and service for exact behavior. See `scripts/export-contracts.mjs` and `scripts/contract-parity.mjs` for contract tooling.
- **App instructions** — **Frontend** `apps/guest-portal/AGENTS.md`, `apps/partner-dashboard/AGENTS.md`, `apps/admin-console/AGENTS.md` and root `CLAUDE.md`. For backend-facing operator details, see [Admin](../admin-dashboard/README.md) and [Scanner](../scanner-app/README.md).
- **Deployment** — [Render staging](../operations/render-staging.md), [staging environment contract](../operations/staging-environment-contract.md) and backend `render.yaml`. **Frontend** `apps/<app>/vercel.json` for per-app settings and `docs/scanner-app/web-deploy.md` for Scanner web and native rollout guidance.
