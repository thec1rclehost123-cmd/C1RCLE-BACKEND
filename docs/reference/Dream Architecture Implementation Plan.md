## Dream Architecture Implementation Plan Final destination

At launch, THE C1RCLE will work like this:

Partner Dashboard

- \- Venue Studio

- \- Host Studio

- \- Promoter Studio

Guest Portal Mobile App Scanner App Admin Console

↓

Shared contracts and generated API clients

↓

Fastify API Gateway

↓

Core business brain

↓

Repositories and provider adapters

↓

PostgreSQL + Firestore + Redis + external providers

↓

Outbox events and background jobs

↓

Every application stays synchronized

There will be:

- One business backend

- One authentication model

- One authorization model

- One contract source

- One event lifecycle

- One order lifecycle

- One payment finalizer

- One ticket authority

- One check-in authority

- One financial ledger

- One audit trail

Web apps may retain thin server adapters for cookies, SSR and file handling. They will not contain business logic or directly own database records.


## Stage 0: Protect and record the current system

## Goal

Create a safe starting point before restructuring anything.

## Work

- Record the exact Git branch and commit.

- Preserve existing uncommitted work.

- Export the current test Firestore data.

- Export or document Firebase Auth test users.

- Back up test Storage files.

- Record all environment variables without exposing secrets.

- Record Firebase project IDs, Redis instances and payment modes.

- Record current APIs, database collections, jobs and providers.

- Run the current focused tests.

- Record every existing failure.

- Create deterministic test users and organizations.

Test personas should include:

- Platform admin

- Organization owner

- Venue manager

- Host event manager

- Promoter

- Finance manager

- Door manager

- Scanner staff

- Guest Portal user

- Mobile user

- Banned or disabled user

## Important protection

Do not rewrite payment, ticket, refund, scanner or payout logic yet. First surround those workflows with tests.

## Stage complete when

- Current test data can be restored.

- Current behavior can be reproduced.

- Existing failures are documented.

- Every important workflow has an identified current owner.

- No destructive migration has occurred.

## Stage 1: Create shared contracts

## Goal

Give every application one common language.

## New package


packages/contracts/

## Shared foundations

Create schemas for:

- Identifiers

- Money and currency

- Timestamps

- Pagination

- Sorting

- Filtering

- Standard success responses

- Standard error responses

- Request IDs

- Idempotency keys

- Resource versions

- Authentication context

- Organization context

- Permissions

Then add domain contracts for:

- Users

- Organizations

- Venues

- Events

- Ticket tiers

- Inventory

- Orders

- Payments

- Tickets

- Transfers

- Refunds

- Check-ins

- Promoters

- Commissions

- Payouts

- Campaigns

- Notifications

- Analytics

## Contract approach

Each contract should start as a Zod schema:

```
export const EventSchema = z.object({
id: z.string(),
organizationId: z.string(),
title: z.string(),
```


```
status: EventStatusSchema,
version: z.number().int(),
createdAt: z.string().datetime(),
updatedAt: z.string().datetime(),
});
export type Event = z.infer<typeof EventSchema>;
```

The same schema powers:

- Gateway validation

- TypeScript types

- OpenAPI

- Partner Dashboard client

- Guest Portal client

- Mobile client

- Scanner client

- Admin client

- Contract tests

## Compatibility

Existing V1 APIs remain available temporarily. Compatibility adapters translate old responses into canonical contracts.

## Stage complete when

- The gateway and at least one client use the same schemas.

- OpenAPI can be generated from those schemas.

- No database document is exposed directly.

- Standard errors work across all clients.

## Stage 2: Centralize configuration and infrastructure foundations Goal

Stop individual modules from reading random environment variables or creating provider clients independently.

## Build

Create validated configuration packages for:

- API Gateway

- Web clients

- Mobile

- Scanner

- Firebase

- PostgreSQL

- Redis

- Razorpay or other payment providers

- Messaging providers

- Search providers


- Storage

- Inngest

- Sentry

Production must fail during startup when required configuration is missing.

It must never silently fall back to:

- Localhost

- Test Firebase

- Demo events

- Fake payments

- Disabled authorization

- Development API keys

## Shared technical tools

Create injectable interfaces for:

- Clock

- ID generator

- Database transaction

- Distributed lock

- Idempotency storage

- Audit writer

- Outbox writer

- Payment provider

- Messaging provider

- Search provider

- Storage provider

## Stage complete when

- Core modules no longer need to read process.env.

- Provider configuration is validated once.

- Test environments can inject fake clocks and providers.

- Production demo modes fail closed.

## Stage 3: Rebuild authentication and identity

## Goal

Create one reliable identity flow across every application.

## Authentication flow

- 1. User authenticates with Firebase.

- 2. Firebase returns an ID token.

- 3. Client sends the token to /v2/session/sync.

- 4. Gateway verifies the token.

- 5. Identity service resolves one platform user.

- 6. Backend loads onboarding, bans and account status.

- 7. Backend loads organization memberships and permissions.


8. Client receives the canonical session.

## Required identity behavior

- Phone authentication

- Apple login

- Google login

- Correct account linking

- Email or phone collision handling

- Token refresh

- Logout

- Disabled accounts

- Deleted accounts

- Banned accounts

- Guest-to-user conversion

- Account export

- Account deletion

- Authentication audit history

## Application implementation

## Partner Dashboard

## Receives:

- User

- Organizations

- Memberships

- Active organization

- Partner capabilities

- Roles

- Permissions

- KYC status

- Bank-account readiness

## Guest Portal and Mobile

## Receive:

- Guest/user profile

- Onboarding status

- Purchase readiness

- Wallet readiness

- Notification preferences

- Subscription status where relevant

## Scanner

Receives a narrower session:

- Staff ID

- Organization

- Venue


- Event

- Door

- Device

- Allowed scanner actions

- Expiration

## Admin

Receives platform-admin permissions. Sensitive operations can require a recent login or step-up verification.

## Stage complete when

- The same person cannot accidentally create multiple platform identities.

- Guest purchases survive account conversion.

- Revoked users lose access within the agreed time.

- Every application uses /v2/session.

- Authentication tests cover real allow and deny cases.

## Stage 4: Organizations, roles and authorization

## Goal

Create one backend-enforced access system.

## Canonical model

## User

- > OrganizationMembership

- > Role

-> Permissions

- > Venue/Event scopes

## Organization capabilities

An organization may operate as:

- Host

- Venue

- Promoter

- Combined partner organization

These are organization capabilities—not separate login systems.

## Suggested roles

- OWNER

- ADMIN

- EVENT_MANAGER

- VENUE_MANAGER

- FINANCE_MANAGER

- MARKETING_MANAGER

- DOOR_MANAGER

- PROMOTER

- VIEWER


## PLATFORM_ADMIN

## Authorization sequence

Every protected request follows:

- 1. Verify user.

- 2. Resolve active organization.

- 3. Verify active membership.

- 4. Check permission.

- 5. Check resource ownership.

- 6. Check venue/event scope.

- 7. Execute the command.

- 8. Record sensitive actions.

## Example

A user with event.update for Venue A must not automatically update an event belonging to Venue B.

Knowing the event ID is never enough.

## Application work

- Partner navigation comes from permissions.

- Buttons may be hidden for usability.

- Backend still enforces every permission.

- Scanner receives only door permissions.

- Promoter only sees assigned events and financial data.

- Admin actions require platform permissions and audit reasons.

## Stage complete when

- Cross-organization IDOR tests fail safely.

- Role revocation works.

- Resource-level scope is enforced.

- No route infers authority from client-provided organization IDs alone.

## Stage 5: Restructure the Core business brain

## Goal

Separate business rules from Firestore, Fastify and provider SDKs.

## Target Core layers

Domain layer

Pure rules, entities and state machines

Application layer

Commands, queries and workflow coordination

## Ports

Repository and provider interfaces

Infrastructure adapters


Firestore, PostgreSQL, Redis and providers

## Migration method

For every existing engine:

- 1. Find all callers.

- 2. Identify the current authoritative behavior.

- 3. Write characterization tests.

- 4. Define the new command or query.

- 5. Extract the pure business rules.

- 6. Define repository interfaces.

- 7. Put current Firestore behavior behind an adapter.

- 8. Migrate one route.

- 9. Compare old and new results.

- 10. Migrate remaining callers.

- 11. Remove the old engine only after proof.

## First Core domains

Start with:

- Identity

- Organizations

- Permissions

- Venues

- Events

- Scheduling

Then move to:

- Pricing

- Inventory

- Orders

- Payments

- Tickets

- Refunds

- Check-ins

- Finance

## Large engines

Modules such as ticket sharing, cover charge, ticketing workflows, checkout and discovery must be split by responsibility—but only after their current behavior is tested.

## Stage complete when

- Domain modules do not import Firebase.

- Domain modules do not import Fastify.

- Domain modules do not import payment/provider SDKs.

- Domain modules do not read environment variables.


- Important state machines have one authority.

- Repository and provider adapters have contract tests.

## Stage 6: Make the API Gateway thin

## Goal

Turn Fastify into a secure transport layer.

## Every route should do only this

- 1. Authenticate.

- 2. Resolve organization context.

- 3. Check permission and resource scope.

- 4. Validate request.

- 5. Call one application service.

- 6. Validate or serialize response.

- 7. Convert domain errors into standard HTTP errors.

## Route policy manifest

Every route must explicitly document:

- Public or protected

- Identity type

- Permission

- Resource scope

- Input schema

- Output schema

- Rate limit

- Idempotency

- Concurrency behavior

- Audit behavior

- Cache behavior

- Owning Core module

## Remove direct database access

The 47 route modules with direct database signals are migrated workflow by workflow.

Architecture tests should reject future .collection() calls inside gateway route folders.

## App-local APIs

Partner, Guest and Admin app-local APIs are classified as:

- Temporary compatibility proxy

- Thin cookie/SSR adapter

- Business backend that must move

Final web adapters may handle:

- HTTP-only cookies

- CSRF


- SSR

- Upload/download streaming

They may not own business rules or database writes.

## Stage complete when

- Routes contain no Firestore queries.

- Protected routes have explicit policies.

- OpenAPI matches live validation.

- V1 compatibility routes are observable and documented.

## Stage 7: Build the common Partner Dashboard shell

## Goal

Create one product containing Venue, Host and Promoter Studios.

## Shared shell

## Build:

- Authentication layout

- Organization selector

- Studio selector

- Main navigation

- Global search

- Notifications

- User menu

- Permission-denied state

- Loading states

- Empty states

- Error and retry states

- Stale-data indicators

- Confirmation dialogs

- Audit links

- Responsive layouts

- Accessibility foundations

## Shared frontend architecture

app/ components/ features/ hooks/ services/ queries/ contracts/ permissions/

## Use:

- Generated API client

- React Query


- Shared query keys

- Shared mutations

- Shared form schemas

- Shared design tokens

- Shared accessible components

## Studio boundaries

## Venue Studio

- Venue operations

- Calendar and slots

- Hosted events

- Tables and menus

- Staff and doors

- Venue finance

## Host Studio

- Event production

- Ticketing and promotions

- Guests and audience

- Promoter assignments

- Event finance

## Promoter Studio

- Assignments

- Referral links

- Sales attribution

- Commissions

- Payout status

- Performance

## Stage complete when

- Studios feel like one product.

- Navigation is permission-driven.

- No screen uses fake production data.

- No screen talks directly to Firestore for business data.

- Feature flags can enable each studio safely.

## Stage 8: Canonical venues and event read paths

## Goal

Make Partner, Guest and Mobile read the same event truth.

## Backend

## Build:

- Venue queries

- Event list queries

- Event detail query


- Calendar query

- Public event projection

- Public venue projection

- Preview projection

- Search projection

- Pagination and filters

- Cache ownership

- Projection freshness information

## Partner

Implement:

- Venue details

- Event lists

- Event details

- Search

- Filters

- Calendar

- Draft/private views

- Public preview

## Guest Portal

Implement:

- SEO event pages

- Venue pages

- Browse and filters

- Public schedules

- Public ticket tiers

## Mobile

Implement:

- Discovery

- Personalized feed

- Search

- Map

- Event details

- Venue details

## Consistency rule

Partner may see private fields. Guest and Mobile receive a controlled public projection of the same event ID and version.

## Stage complete when

- Partner, Guest and Mobile agree on public event facts.

- Drafts do not leak.

- Cancelled/unpublished events disappear correctly.


- Pagination and query costs are bounded.

- Time-zone behavior is tested.

## Stage 9: Event creation and publishing Goal

Create one safe event-writing workflow.

## Event editor

Implement:

- Basic information

- Venue and location

- Sessions and schedule

- Ticket tiers

- Capacity

- Sale windows

- Tables/packages

- Promo codes

- Posters and media

- Guest policies

- Promoter assignments

- Commission terms

- Preview

- Review and publishing

## Event state machine

## DRAFT

- > REVIEW

- > SCHEDULED

- > PUBLISHED

- > SALES_PAUSED

- > STARTED

- > ENDED

- > ARCHIVED

Possible terminal path:

## CANCELLED

Every transition has explicit rules.

## Publish transaction

The publish command:

- Checks permission

- Checks organization and venue scope

- Validates schedule

- Validates tiers and capacity

- Validates sale windows


- Checks version

- Changes canonical state

- Writes audit record

- Writes outbox event

Jobs then update:

- Guest Portal

- Mobile

- Search

- Cache

- Notifications

- Analytics

## Stage complete when

A partner can create and publish once, and the event appears exactly once everywhere—even when the publish request is retried.

## Stage 10: Pricing, inventory and checkout Goal

Make every purchase begin from an authoritative server quote and inventory hold.

## Pricing service

Owns:

- Base price

- Fees

- Taxes

- Promotions

- Surge rules

- Table/package pricing

- Currency

- Rounding

- Quantity limits

- Final total

All money is stored in integer minor units.

## Inventory service

Owns:

- Available quantity

- Reserved quantity

- Sold quantity

- Holds

- Hold expiry

- Release

- Conversion to sold

- Capacity limits


- Concurrency

Redis helps with locking, but durable storage remains authoritative.

## Checkout flow

- 1. Client requests quote.

- 2. Server validates event and tiers.

- 3. Server creates inventory hold.

- 4. Order is created with immutable price snapshot.

- 5. Payment attempt is created if required.

- 6. Client opens payment UI.

- 7. Client waits for backend confirmation.

The client never declares itself paid.

## Stage complete when

- Two users cannot buy the last ticket.

- Repeated checkout requests do not create duplicate orders.

- Expired holds release inventory.

- Guest and Mobile produce the same totals.

- Free and paid orders follow compatible lifecycles.

## Stage 11: Payments and webhook finalization

## Goal

Create one payment authority.

## Payment records

## Store:

- Internal payment ID

- Order ID

- Provider

- Provider order ID

- Provider payment ID

- Amount

- Currency

- Status

- Attempt number

- Idempotency key

- Signature state

- Created/updated timestamps

## Webhook flow

- 1. Provider sends webhook.

- 2. Gateway reads the raw body.

- 3. Signature is verified.

- 4. Webhook event is recorded before processing.

- 5. Duplicate delivery returns the previous result.


- 6. Payment is matched to the order.

- 7. Amount and currency are verified.

- 8. Paid-order finalizer runs transactionally.

- 9. Outbox events are created.

- 10. Provider, payment, order and ledger states reconcile.

## Failed finalization

A captured payment without issued tickets must enter an operational exception queue. It must never silently disappear.

## Stage complete when

- Provider replay does not issue duplicate tickets.

- Client callbacks cannot fake payment.

- Amount mismatches fail safely.

- Captured-but-unfulfilled payments trigger alerts.

- Reconciliation identifies every mismatch.

## Stage 12: Orders, tickets, wallet and transfers

## Goal

Create one admission authority.

## Order authority

The Order aggregate owns:

- Buyer

- Event

- Items

- Price snapshot

- Payment status

- Fulfillment status

- Refund status

## Ticket authority

One ticket or entitlement represents one admission unit.

Ticket states:

RESERVED

ISSUED

TRANSFER_PENDING

TRANSFERRED

CHECKED_IN

CANCELLED

REFUNDED

VOID

## Wallet

Guest and Mobile wallets are projections of canonical entitlements.

They do not independently create tickets.


QR credentials must be:

- Signed

- Versioned

- Scoped

- Revocable

- Expiring or rotating where appropriate

- Safe against raw identifier guessing

## Transfer

- 1. Owner selects eligible ticket.

- 2. Backend validates ownership and state.

- 3. Expiring single-use claim is created.

- 4. Recipient authenticates.

- 5. One transaction changes ownership.

- 6. Old QR authority is revoked.

- 7. Both wallets update.

## Stage complete when

- One paid item creates the correct number of entitlements.

- Wallets agree across Web and Mobile.

- Transfer cannot duplicate ownership.

- Refunded and transferred QR credentials stop working.

- Supported wallet passes are validated in real environments.

## Stage 13: Guests, promoters and staff

## Goal

Complete the people and partner operations around events.

## Guests

## Build:

- Guest profiles

- Audience views

- Guest lists

- Guest-list entries

- Invitations

- RSVP

- Check-in status

- Privacy-aware search

- Audited exports

- Retention and deletion rules

## Promoters

## Build:

- Promoter identity

- Event assignments


- Assignment acceptance

- Referral links

- Referral codes

- Attribution

- Versioned commission terms

- Sales performance

- Commission statements

- Payout visibility

Attribution is saved on the order. It is not recalculated later from mutable links.

## Staff

## Build:

- Organization membership

- Venue assignment

- Event assignment

- Door assignment

- Role and permission

- Invitation expiry

- Session revocation

- Device binding where needed

## Stage complete when

- Promoters only see assigned information.

- Door staff only see minimum required guest data.

- Exports require permission and create audit records.

- Commission calculations use the correct historical terms.

## Stage 14: Scanner and door operations

## Goal

Guarantee one valid admission per entitlement.

## Scanner setup

- 1. Staff authenticates.

- 2. Backend checks door permission.

- 3. Device is bound.

- 4. Session is scoped to organization, venue, event and door.

- 5. Scanner receives minimal event configuration.

## Scan flow

- 1. Scanner reads QR.

- 2. Token and scanner session go to the gateway.

- 3. Signature and token version are checked.

- 4. Entitlement is resolved.

- 5. Event scope is checked.

- 6. Transfer, refund, cancellation and revocation are checked.


- 7. Existing check-in is checked.

- 8. Transaction creates one CheckIn.

- 9. Ticket becomes checked in.

- 10. Live counts update.

## Duplicate behavior

A repeated scan returns the original result and a clear “already checked in” message. It must not create another admission.

## Offline strategy

Offline scanning needs:

- Signed offline data

- Short validity window

- Device scope

- Local duplicate cache

- Clear sync state

- Conflict handling

- Restricted overrides

Offline support should not be claimed until physical-device testing proves it.

## Stage complete when

- Simultaneous devices cannot double-admit.

- Wrong-event tickets fail.

- Refunded, transferred and revoked tickets fail.

- Manual override is permissioned and audited.

- Physical Android/iOS scanner tests pass under weak connectivity.

## Stage 15: Refunds, ledger and finance

## Goal

Make every financial movement explainable and reconcilable.

## Refund workflow

- 1. Request is created.

- 2. Refund policy is evaluated.

- 3. Refundable amount comes from immutable order facts.

- 4. Provider refund is submitted idempotently.

- 5. Callback or reconciliation confirms the result.

- 6. Order and payment states update.

- 7. Tickets are revoked.

- 8. Inventory is adjusted according to policy.

- 9. Ledger entries reverse.

- 10. Commissions and balances update.

- 11. Wallet and apps receive projections.

## Ledger

Use an immutable double-entry ledger.


Ledger facts include:

- Ticket revenue

- Fees

- Taxes

- Promoter commission

- Venue share

- Host share

- Refund reversal

- Payout reservation

- Payout completion

- Controlled adjustment

Balances are calculated from ledger facts, not hand-edited totals.

## Finance UI

Partner Dashboard shows:

- Orders

- Payments

- Refunds

- Fees

- Taxes

- Commissions

- Pending balance

- Available balance

- Payout reservations

- Settled balance

- Reconciliation issues

## Stage complete when

Provider, order, payment, refund, ticket and ledger totals match exactly.

## Stage 16: Bank accounts and payouts

## Goal

Allow controlled partner payouts without creating financial risk.

## Bank-account flow

- Finance permission required

- Sensitive data protected

- Verification state recorded

- Changes require confirmation

- Changes create audit records

- Previous account history is preserved safely

## Payout flow

- 1. Calculate available balance.

- 2. Exclude pending, disputed and reserved amounts.


- 3. Authorized user requests payout.

- 4. Idempotency key is required.

- 5. Transaction reserves the balance.

- 6. Payout enters PENDING.

- 7. Approval rules run.

- 8. Provider receives payout request.

- 9. Callback/reconciliation finalizes it.

- 10. Ledger reservation becomes completed or released.

## Safety

Payout commands remain disabled until:

- KYC works

- Bank verification works

- Ledger reconciliation passes

- Provider callbacks are verified

- Failed payouts recover safely

- Concurrent payout requests cannot overspend

## Stage complete when

Every payout can be traced from ledger balance through provider completion.

## Stage 17: Campaigns, notifications and communication Goal

Give partners communication tools without creating spam, privacy or cost problems.

## Campaign workflow

- 1. Partner selects audience.

- 2. Backend checks permission.

- 3. Consent and suppression rules apply.

- 4. Backend calculates recipient estimate and cost.

- 5. Partner confirms.

- 6. Recipient snapshot is frozen.

- 7. Outbox creates batch jobs.

- 8. Workers send through provider adapters.

- 9. Delivery callbacks update attempts.

- 10. Partner sees delivery metrics.

## Channels

- Push

- Email

- SMS

- WhatsApp, if approved

- In-app notifications

## Controls


- Unsubscribe

- Quiet hours

- Frequency caps

- Organization quotas

- Provider cost limits

- Template approval

- Idempotent sending

- Dead-letter and retry tools

## Stage complete when

No ineligible recipient receives a message and delivery/cost totals reconcile.

## Stage 18: Social, chat, discovery and analytics Goal

Complete the guest experience using canonical access rules and rebuildable projections.

## Social and chat

Firestore may remain for realtime behavior, but Core/gateway must enforce:

- Chat membership

- Event entitlement requirements

- Blocks

- Bans

- Reports

- Moderation

- Message limits

- Removal

- Privacy

## Discovery

Use canonical event publication events to update:

- Guest Portal

- Mobile discovery

- Search

- Recommendations

- Homepage curation

- Maps

- Venue pages

## Analytics

Create a metric registry defining:

- Metric name

- Formula

- Source events

- Time zone


- Dimensions

- Freshness

- Refund behavior

- Late-event behavior

- Projection version

Partner metrics should be reconcilable to canonical facts.

## Stage complete when

- Chat access cannot be bypassed.

- Search does not show private events.

- Analytics can be rebuilt.

- Finance metrics match the ledger.

- Projection freshness is visible.

## Stage 19: Move transactional data to PostgreSQL Goal

Give commerce and finance strong transactional storage.

## SQL authority

Move these domains:

- Inventory

- Holds

- Orders

- Order items

- Payments

- Webhook events

- Refunds

- Tickets

- Transfers

- Check-ins

- Ledger entries

- Commissions

- Balance reservations

- Payouts

## Migration approach

- 1. Define SQL schema.

- 2. Create migration files.

- 3. Back up current test data.

- 4. Backfill canonical IDs and states.

- 5. Validate counts and totals.

- 6. Introduce repository adapters.

- 7. Shadow-write where useful.

- 8. Shadow-read and compare.


- 9. Reconcile every difference.

- 10. Switch one domain authority.

- 11. Keep rollback compatibility.

- 12. Remove old Firestore authority after proof.

## Firestore remains for

- Public projections

- Wallet projections

- Live door state

- Notifications

- Chat

- Presence

- Selected profiles during transition

- Realtime operational views

## Stage complete when

- SQL is authoritative for transactional domains.

- Firestore projections are replayable.

- No client dual-writes.

- Migration and rollback are rehearsed.

## Stage 20: Remove legacy routes and duplicate systems

## Goal

Finish the architecture without breaking supported clients.

## For every old route

- 1. Find static consumers.

- 2. Add runtime route telemetry.

- 3. Ship the V2 replacement.

- 4. Migrate Partner.

- 5. Migrate Guest.

- 6. Migrate Mobile.

- 7. Migrate Scanner/Admin/jobs.

- 8. Monitor supported client versions.

- 9. Add deprecation warnings.

- 10. Remove business ownership.

- 11. Remove compatibility proxy.

- 12. Remove route after zero-use proof.

## Clean up

- Direct Firestore route handlers

- App-local business APIs

- Duplicate Core engines

- Files ending in 2

- Stale compiled exports


- Conflicting status names

- Duplicate contract types

- Obsolete collections

- Old background jobs

- Unused provider integrations

- Fake/demo production fallbacks

## Stage complete when

- Every resource has one owner.

- No supported client uses old endpoints.

- Old collections have backup and removal proof.

- Architecture checks prevent regression.

## Stage 21: Complete staging proof

## Goal

Run the entire platform as real users before production.

## Mandatory end-to-end journey

- 1. Owner creates an organization.

- 2. Owner invites venue staff, host staff and promoter.

- 3. Venue accepts a slot.

- 4. Host creates an event.

- 5. Host creates tiers, promos and tables.

- 6. Host assigns promoter terms.

- 7. Event is published.

- 8. Event appears in Guest Portal.

- 9. Event appears on physical Mobile devices.

- 10. Guest completes free checkout.

- 11. Guest completes real provider test-mode paid checkout.

- 12. Verified webhook issues tickets once.

- 13. Ticket appears in Web and Mobile wallets.

- 14. Partner sees order, guest and finance facts.

- 15. Promoter receives correct attribution.

- 16. Ticket is transferred and claimed.

- 17. Old QR stops working.

- 18. Two physical scanners test duplicate protection.

- 19. Refund reverses ticket, wallet, order, payment, commission and ledger.

- 20. Campaign sends to eligible test recipients.

- 21. Analytics reaches the expected totals.

- 22. Payout test follows controlled provider flow.

- 23. Backup restore is rehearsed.

- 24. Deployment rollback is rehearsed.

## Non-functional testing


- Security and IDOR

- Load and concurrency

- Rate limits

- Webhook replay

- Redis loss

- Database failure

- Job retry

- Projection delay

- Network loss

- Scanner offline behavior

- Accessibility

- Mobile restart

- Deep links

- Push notifications

- Privacy export/deletion

## Stage complete when

- Exact-SHA evidence exists.

- No P0 or P1 issue remains.

- Financial reconciliation is exact.

- Physical devices pass.

- Monitoring and rollback work.

- Formal GO approval is recorded.

## Stage 22: Production launch Deployment order

- 1. Freeze approved release candidate. 2. Take final backups. 3. Verify production environment manifest. 4. Apply additive database migrations. 5. Deploy contracts and backend. 6. Verify health, version and dependencies. 7. Test provider webhooks. 8. Deploy Partner Dashboard. 9. Deploy Guest Portal. 10. Deploy Admin Console. 11. Release Scanner-compatible build. 12. Release backward-compatible Mobile builds. 13. Enable features gradually. 14. Monitor every critical workflow. 15. Hold final GO/NO-GO checkpoint.

## Progressive rollout


## Enable in this order:

- 1. Internal admins

- 2. Internal test organization

- 3. Selected venue

- 4. Selected host/promoter

- 5. Limited guest traffic

- 6. Wider public traffic

Security enforcement is never feature-flagged off.

## Stage 23: Post-launch stabilization

## First days

## Monitor:

- Login failures

- Permission denials

- API errors and latency

- Database and Redis health

- Checkout conversion

- Payment webhook delays

- Ticket issuance failures

- Wallet projection delays

- Duplicate/invalid scans

- Refund failures

- Ledger mismatches

- Payout failures

- Campaign delivery

- Client-version adoption

## Cleanup

- Resolve reconciliation exceptions daily.

- Remove temporary feature flags.

- Remove compatibility proxies after adoption.

- Review provider costs.

- Review database query costs.

- Review incidents.

- Update runbooks.

- Run first production restore drill.

- Perform security and privacy review.

## Final definition of success

The dream architecture is complete when:

- Every application uses the same contracts.

- Fastify is the only business API authority.


- App-local BFFs are transport-only.

- Core owns business rules without infrastructure coupling.

- PostgreSQL owns transactional commerce and finance.

- Firestore provides intentional realtime projections.

- Redis is never the only durable truth.

- Payments are finalized by verified backend evidence.

- One entitlement equals one admission unit.

- Scanner check-in is atomic.

- Refunds reverse every connected domain.

- Ledger and provider totals reconcile.

- Permissions are enforced on the backend.

- Partner changes appear correctly in Guest and Mobile.

- Every critical physical-device journey passes.

- Backups, monitoring, incidents and rollbacks are rehearsed.

- The release has explicit, evidence-backed GO approval.
