> **Point-in-time gap analysis, audited HEAD `2a9a4b3` (backend) / `df73e9b` (frontend),
> 2026-08-31.** Moved here 2026-09-05 from `docs/reference/Untitled document.md`, where it
> sat unindexed and undiscovered despite being the most detailed implementation-vs-design
> audit in the repo (target architecture, 25 non-negotiable rules, a 15-item contradiction
> log between the planning docs, per-domain LIVE/NO-BACKEND status table, the complete
> 501 list with file:line). Route/test/lint-failure counts below are exact **as of that
> commit** — re-verify against current `git log` / `pnpm check` before citing a number as
> today's truth; a later session (`ff32861`, CI pipeline + Phase-5 bugfixes) claims some of
> the §5 "Quality debt" failures fixed, not independently re-verified here.

Legend for citations (all paths absolute):

* **DEC** \= c:/Users/SHRIYASH SAWANT/OneDrive/Desktop/Circle1/C1RCLE-BACKEND/docs/architecture/decisions.md  
* **ARCH** \= c:/Users/SHRIYASH SAWANT/OneDrive/Desktop/Circle1/C1RCLE-BACKEND/docs/architecture/README.md  
* **DREAM** \= c:/Users/SHRIYASH SAWANT/OneDrive/Desktop/Circle1/C1RCLE-BACKEND/docs/reference/Dream Architecture Implementation Plan.md  
* **MLIP** \= c:/Users/SHRIYASH SAWANT/OneDrive/Desktop/Circle1/C1RCLE-BACKEND/docs/reference/MASTER\_LAUNCH\_IMPLEMENTATION\_PLAN.md  
* **MP** \= .../C1RCLE-BACKEND/docs/reference/V2 Backend Engineering — Senior Developer \- IT Team Master Prompt.md (byte-identical, modulo line endings, to c:/Users/SHRIYASH SAWANT/OneDrive/Desktop/Circle1/V2 Backend Engineering — Senior Developer \- IT Team Master Prompt.md — verified via diff \-w)  
* **RM** \= .../C1RCLE-BACKEND/docs/roadmap/ROADMAP.md  
* **P0..P8** \= .../C1RCLE-BACKEND/docs/roadmap/phase-0X-\*.md  
* **P4X** \= c:/Users/SHRIYASH SAWANT/OneDrive/Desktop/Circle1/PHASE\_4\_PLUS\_EXECUTION\_PLAN.md

---

# **1\. TARGET ARCHITECTURE**

## **Layer stack (dependency flows downward; each layer knows only the one below)**

C1RCLE-FRONTEND  (Next 16 / Expo)  
  └ @c1rcle/api-client  — ONLY network client (base URL, auth, retries, timeouts, x-request-id)   ARCH:27-31  
  └ @c1rcle/auth/session-store — access token IN MEMORY only; httpOnly cookie owned by backend  
        │ HTTP  /api/v2  
        ▼  
apps/api-gateway  (Fastify 5, :8080)   — transport only: mint/echo x-request-id → error envelope →  
  route-manifest (registration authority) → thin route                                            ARCH:33-42  
        │  route \= validate → auth → policy/scope → ONE service call → serialize                   DEC:73-80  
        ▼  (injects CoreConfig \+ repositories \+ logger)  
packages/core  (@c1rcle/core — pure TS, ZERO infra imports)                                        ARCH:43-48  
  ├ application/\*-service.ts  — one service per use-case; orchestrates; throws typed DomainError  
  ├ domain/models/\*.ts        — aggregates \+ explicit FSM tables \+ versioned entities (value objects)  
  ├ domain/ports/repositories.ts — repository INTERFACES, storage-agnostic, TxContext on writes    ARCH:83  
  └ infrastructure/{memory,firestore}/ — one adapter file per port; only place storage engine is known  
packages/contracts  — zod v4 wire schemas \+ error envelope; mirrors frontend 1:1                   ARCH:49  
        ▼  
Firestore v2\_\* collections (V1 & V2 kept fully separate)                                           DEC:123, P0:30-34

Dream-state destination adds: PostgreSQL \= transactional truth, Firestore \= realtime projections only, Redis \= cache/locks/limits (never durable truth), transactional outbox \+ Inngest jobs, provider adapters (DREAM:21-41; MLIP:28-68).

## **Core one-liner (binding, verbatim)**

> "**Frontend asks. Backend decides. Database remembers.**" (ARCH:20)

> "**No route file ever touches a database; no domain file ever reads process.env; no frontend code ever runs a query.**" (ARCH:58)

> "route files only: validate → auth → policy/scope → ONE service call → serialize. No .collection(/.doc(, no inline business enums, no process.env. Enforced by scripts/check-boundaries.mjs \+ eslint no-restricted-\*." (DEC:76-79, "D-005 · Route \= thin. Service \= decisions. Model \= rules.")

> "D-006 · BLOCKED slices are absent, not stubbed (404, never 501)" — "anything not in the route manifest ... is simply **not registered**" and "A test asserts no 501 exists." (DEC:81-88)

## **Patterns mandated**

| Pattern | Rule / cite |
| ----- | ----- |
| **Modular monolith** | "The backend MUST follow a Modular Monolith Architecture. Do not turn the system into microservices unless explicitly instructed." (MP:153-159); "strong internal module boundaries" (MP:163); Fastify modular monolith (ARCH:18) |
| **Thin routes** | DEC:73-80; ARCH:94,103; RM:50; P4X:236 |
| **Explicit FSM / state machines** | domain/fsm.ts transitionStatus(from,to,table): "**same-state \= idempotent no-op** (retry-safe); anything unlisted → StateTransitionError" (ARCH:77). Event table draft→review→scheduled→published⇄sales\_paused→started→ended→archived, any→cancelled, cancelled terminal (ARCH:81; DREAM:1046-1068). publish() walks review→scheduled→published one validated edge at a time rather than widening the table (DEC:138-152, D-010) |
| **Versioned entities / value objects** | newVersionedEntity/bumpVersion; "version starts at 1 and increments per write" (ARCH:76); pricing/money as value objects, integer paise (P4:69-85) |
| **Optimistic locking** | If-Match: version → 409 conflict, never silent overwrite (ARCH:146; §5:165). Compare-and-set enforced **in the adapter inside runTransaction**, not in the service — "a write of version N must find N-1 in storage"; version 1 exempt (DEC:267-291, D-015) |
| **Idempotency** | Idempotency-Key on every write, 24h TTL (DEC:391-394); durable FirestoreIdempotencyStore, claim via Firestore create() so winner is atomic (DEC:293-314, D-016); "Every write is idempotent ... and optimistically locked" (RM:54) |
| **Transactional outbox** | "business write \+ event row in one unit of work; consumers (audit, projections) react later — no service-to-service calls" (ARCH:150). Outbox event written in same runTransaction as business write; consumer idempotency by event ID; "kill-after-commit does not lose row" (DEC:430-443, D-021) |
| **Event bus / versioned domain events** | MLIP:520-538 (Stage 21); ARCH:47 |
| **Idempotency \+ optimistic lock TTLs** | resolved: Idempotency-Key 24h, If-Match version-based (DEC:391-394) |
| **Contract-first** | packages/contracts is "the single source ... must mirror C1RCLE-FRONTEND/packages/types \+ api-client/src/schemas.ts **1:1**"; parity script fails on drift → fix frontend copy, "no silent divergence" (DEC:51-59, D-003). Error envelope single-sourced in contracts, flat everywhere (DEC:61-71 D-004, 125-137 D-009). Same zod schema powers gateway validation \+ TS types \+ OpenAPI \+ every client (DREAM:242-260) |
| **Ports & adapters (hexagonal)** | "Nothing in shipped code depends on a concrete store. The domain depends on interface …Repository" (DEC:37-38, D-002); Core independent of Firebase/Fastify/provider SDKs/env (DREAM:689-698) |
| **DI / injected config** | createCoreConfig — injected clock, id-gen, redis, firestore, features; "It is *constructor/DI only*" (ARCH:75); gateway config/index.ts \= "**THE ONLY process.env reader (guardrail-enforced)**" (ARCH:96) |
| **Fail closed** | "missing env/keys/config/unknown-state → error, never silent default" (ARCH:156); firestore driver w/o creds → config throws at boot, "never a silent memory fallback" (P0:43) |
| **IDOR guard / default-deny ABAC** | "actor.organizationId must equal the :organizationId path param / X-Organization-Id ... mismatch → 403, **never a resource-not-found leak**" (ARCH:138-139); owner/enumeration responses collapse to same error, "never an oracle" (ARCH:160) |
| **Policy order** | "rateLimit → validateV2 → requirePermission → cached, in that order" — rate-limit first, validate before authorize, cache last (DEC:191-206, D-012) |
| **Page-based pagination on the wire** | repositories stay cursor-based; gateway adapts to PageInfo{page,pageSize,total,hasNextPage}; "No cursor leaks to the client" (DEC:89-95, D-007) |
| **Short-lived QR / CSPRNG tokens** | "QR/pass data short-lived, authorized at read time, never stored" (DEC:427; P4:116-117); "access tokens derived from the session (Better Auth), never localStorage" (ARCH:167) |
| **Platform authority ≠ org authority** | PlatformAdmin is its own aggregate in v2\_admins; admin routes carry no requirePermission (DEC:316-335, D-017) |

## **Tech-stack decisions**

* **API framework:** Fastify 5 modular monolith, fresh pnpm monorepo \+ turbo, serves /api/v2 on :8080 (ARCH:18,33; ARCH:122-124).  
* **Language / validation:** TypeScript (eslint flat config strictTypeChecked), zod v4 natives (z.email(), z.url(), z.iso.datetime()) — "no hand-rolled regex chains" (ARCH:68,109-115).  
* **Auth:** **Better Auth** (library) — "not hand-rolled JWT, not Firebase" (DEC:7). Cookie sessions: httpOnly, SameSite=lax, host-only, secure prod-gated; access token \= **Better Auth's own session token** via the Bearer plugin set-auth-token header, **not a minted JWT** (DEC:11-13, 388-390; DEC:480 C-4; P0:73-76). Storage adapter: community better-auth-firestore, v2\_auth\_\* collections (P0:66-72). Session lifetime 7-day / 1-day updateAge, "extend-in-place not rotate" (DEC:494).  
* **Storage:** repository-first. Memory adapter \= dev/test/CI default (STORAGE\_DRIVER=memory, hermetic). First real adapter \= **Firestore** (STORAGE\_DRIVER=firestore), in the existing thec1rcle-india Firebase project, v2\_\*\-prefixed collections, never touching V1 (DEC:33-49, 97-123; P0:14-57). **PostgreSQL** is the stated destination "behind the same interfaces and the same contract suite" (DEC:39-41; DREAM:1822-1911).  
* **Payments:** Razorpay. Webhook POST /api/v2/webhooks/payments/razorpay **must** do HMAC-SHA256 verification with RAZORPAY\_WEBHOOK\_SECRET (validated at cold start), raw-body capture, idempotent claim via status:'settling' transactional lock, deterministic JSON.stringify — "HMAC Verification Not Optional" (DEC:445-455, D-022; P4:144-150).  
* **Cache / locks / limits:** Redis (injected; rate-limit classes, permission context) — "never durable business truth" (MLIP:66; ARCH:166).  
* **Jobs:** transactional outbox \+ Inngest (DREAM:37-41; MLIP:45).  
* **Observability:** pino with redact (authorization/cookie/x-api-key/\*secret\*/\*token\*/\*razorpay\_\*), canonical x-request-id echoed into every ApiClientError.requestId (ARCH:97-98, 157).  
* **Guardrail:** scripts/check-boundaries.mjs fails CI on ① process.env in core ② fetch() outside transport ③ backend SDK imports in domain/service ④ .collection(/.doc( in route files (ARCH:116-120).  
* **Rejected:** hand-rolled JWT, Firebase Auth (DEC:7); Sagar's parallel SQLite (node:sqlite) adapter — reconciled away, kept as future STORAGE\_DRIVER=sqlite option (DEC:154-189, D-011); V1's flat {success,error} envelope — "not ported (fresh V2 only)" (DEC:66-68).

---

# **2\. PHASE PLAN (00–08)**

Source: RM:33-43 status table \+ per-phase files.

* **Phase 0 — Foundation** (status: done 2026-08-13, live-verified). Delivers: Firestore persistence adapters for all 7 ports, Better Auth (signup/login/refresh/logout \+ GET session), the remaining Org/Venue/Event routes, and the path-shape fix (drop /api/v2/partner/\*, nest org resources under /organizations/:organizationId/...). **DoD:** pnpm check fully green (format→lint→typecheck→boundaries→test→build); contract parity 33/33 vs frontend; live curl chain against real Firestore (signup→login→session→create org→IDOR check wrong-org→404→venue→event→previews→publish) with data surviving a mid-sequence process restart; compare-and-set \+ durable idempotency \+ RBAC/rate-limit/cache actually enforced on every partner route (P0:1-235; DEC D-012..D-016).  
* **Phase 1 — Partner dashboards (Host/Venue/Promoter)** (status: substantially done 2026-08-13; finance BLOCKED on Phase 6). Delivers: partnerships graph (venue↔host: request/approve/reject/block/end as 4 POST actions), promoter connections, referral links (attribution written on the order, link owns no money), analytics read-model routes (/organizations/:id/analytics/overview, /events/:id/analytics), RBAC tab-visibility via GET /organizations/:id/access. **DoD:** RBAC \+ tab-visibility computed server-side only (frontend must never derive); commission rounds **down** (Math.floor); analytics returns precomputed aggregates, never raw guest records; cross-tenant partnership reads as 404 not 403; blocked is terminal; tests green \+ parity clean (P1:1-201). Not done: /finance/\* endpoints (no ledger yet — "could only return invented numbers"), richer per-role overview DTOs, PartnerEventSummary/PartnerEventDetail contracts.  
* **Phase 2 — KYC / Onboarding** (status: substantially done 2026-08-14). Delivers: applicant FSM draft→submitted→approved|rejected|changes\_requested (+ changes\_requested→submitted), document upload (label→path convention), admin review queue, tiered admin authority (TIER1 logged / TIER2 \[super,admin,ops,finance\] / TIER3 super only), propose→resolve dual control, before/after audit log, pluggable VerificationProvider (default FormatCheckVerificationProvider, advisory only), org provisioning carrying platformFeePercent by plan (basic 15 / silver 12 / diamond 10). Routes: /api/v2/onboarding/\* \+ /api/v2/admin/\*. **DoD:** approval requires a **human TIER2 decision regardless of provider result — no auto-approve path** (DEC:351); resolve refuses when resolvedBy \=== proposedBy; verification attempts bounded 5/24h per applicant; privilege-escalation guard \= allow-list sanitizeApplicantProfile; first super admin only via out-of-band seed:admin script (writes ADMIN\_SEED audit); 276 tests green, parity 33 (P2:1-144). Deferred: signed storage-upload URLs, approval email (→ Phase 8).  
* **Phase 3 — Event-catalog & scheduling** (status: done 2026-08-13). Delivers: routes only for ticket-tiers, promo-codes, table-packages, promoter-assignments (GET|POST \+ POST .../end) — services pre-existed and were tested. **DoD:** money integer paise everywhere; promo code normalized to uppercase (no early25 vs EARLY25 split); commission terms frozen into the assignment at creation (terms.version) so later rate changes never rewrite past earnings; end is POST .../end (row survives as record), never DELETE; cross-tenant event id → 404; 15 route tests covering serialization, tenancy, idempotent replay, schema rejection of negative price / zero capacity / \>100% rate (P3:1-77). Runtime pricing/redemption logic explicitly pushed to Phase 4\.  
* **Phase 4 — Guest checkout & tickets** (status: done 2026-08-19; 302 tests). Delivers: public discovery/directory routes (/api/v2/public/events|venues|hosts|discovery|search), pricing engine, cart holds (\~10min TTL, idempotent), Razorpay checkout (quote → holds → attempts → verify) with **dual confirmation** (webhook HMAC \+ client redirect, both idempotent, first wins), promo redemption, entitlement issuance \+ wallet, ticket transfer/claim/cancel-transfer, Razorpay webhook. **DoD:** assertReconciles runs on **every** pricing calc (not just tests) — fees computed on the **discounted** subtotal, GST **on fees only** (a tax position, pinned by test); one entitlement per ticket **unit** (couple \= 1 entitlement scanCountAllowed:2); deterministic ids ENT-{orderId}-{tierId}-{index}; markPaid with same paymentId returns order unchanged with **no version bump**; failed order is terminal (retry \= new order); paid order keeps holding inventory past reservation window; QR payload never stored; webhook HMAC tests (tampered→400, valid→processed once); repository contract suite passes against Memory **and** Firestore (P4:1-205; DEC D-020..D-023; P4X:219-232).  
* **Phase 5 — Door / Scanner / Cover-wallet** (status: substantially done 2026-08-21, verified). Delivers: entitlement scan FSM ISSUED→ACTIVE→CONSUMED(terminal)/REVOKED/EXPIRED; "Magic Ticket" rotating QR HMAC(entitlementId : floor(unixTime/30)) for tickets ≥ ₹5000, verify checks current+previous window (±65s drift); scanner-session auth via event\_codes (type: full|scan\_only|charge); door walk-in/dine-in sale with **price always recalculated server-side** from the event catalog; cover-charge wallet (integer paise, idempotency key per mutation, Firestore-txn balance+txn atomicity, velocity limit 3 debits/min/device, terminated wallets reject all mutations, offline debits blocked at API layer, nightlife computeTerminationTime(...,terminationHour=5,tz='+05:30')). **DoD:** two physical scanners cannot double-admit one ticket; offline/reconnect produces no silent duplicates; pnpm check green; core 231/232, gateway 122/122; contract parity (P5:1-320; P4X:229). Still BLOCKED / honest 501: live door stats \+ WebSocket, /door/override (no FSM edge), /door/offline-manifest (nothing signs one), cover-wallet freeze/unfreeze (no service method), real scanner-device bearer-token auth layer.  
* **Phase 6 — Finance / Ledger / Payouts** (status: not started; depends on Phase 4). Delivers: settlement engine — port **System A** (finance-service.ts / partner\_ledger, per-venue parameterized rates from the plan tier), recordTicketSale(...) as the single writer called from checkout confirmation (one txn, idempotent via partner\_ledger\_idempotency/{orderId}), platformFee/venueShare/promoterCommission/hostPayout split; balances **always computed from the ledger, never cached as truth** (denormalized aggregate doc rebuilt by full scan if missing); promoter leaderboard stats in same txn; bank accounts (last4 plaintext, full number encrypted, one isDefault); payouts (min promoter payout ₹100); disputes; T+3 settlement eligibility gate. **DoD** (from P4X:230): "Provider/order/payment/refund/ledger totals reconcile exactly; payouts disabled until prerequisites green" (P6:1-61). System B (ledger-engine.js, hardcoded 5% / 30-70) is reference only — do not port both.  
* **Phase 7 — Admin console backend** (status: not started; depends on Phase 2 \+ Phase 6). Delivers: the rest of the admin console layered on AdminAuthorityService (tiering \+ propose→resolve \+ before/after audit already exist) — venue suspend, financial refund approval, payout batch run, commission adjustment, admin provisioning, partner-type reprovisioning (partnerReprovision()). New collections v2\_support\_tickets, v2\_safety\_reports, v2\_platform\_announcements. **DoD:** none written; backend-first (frontend apps/admin-console is an empty scaffold) (P7:1-27).  
* **Phase 8 — Social / discovery / notifications** (status: not started; lowest priority). Delivers: follow graph (venue/host followers) \+ new-event notification fan-out, chat (event group messages, private conversations, DMs, typing indicators, blocks, reports), notifications \+ reads. **DoD:** none written; explicit gate — "Do not start this phase until a frontend need for it actually exists; re-audit C1RCLE-FRONTEND before beginning" (P8:1-31).

---

# **3\. DESIGN PRINCIPLES — non-negotiable rules a developer must follow**

Consolidated from DEC (D-005, D-006, D-020), ARCH §4–§5, RM:49-56, P4X:234-246, MP:

1. **Single network boundary.** Frontend → @c1rcle/api-client → Fastify /api/v2 gateway only. No app-local business routes, no direct Firestore from the frontend, no client-authoritative price/payment/permission/ticket decisions (RM:49; ARCH:13-21; MLIP:120-126).  
2. **Thin routes.** Route \= validate → auth → policy/scope → ONE service call → serialize. Nothing else (DEC:73-80; RM:50; P4X:236).  
3. **No .collection( / .doc( outside packages/core/src/infrastructure/\*\*.** Guardrail-enforced (DEC:79; ARCH:120; RM:50; P4X:238).  
4. **No process.env in domain/core.** Only apps/api-gateway/src/config/ reads env, zod-validates on cold start, fails fast (ARCH:96; DEC:75; P4X:237).  
5. **Storage stays behind domain/ports/repositories.ts interfaces.** Services/routes never know which adapter is live; zero Firestore/Postgres types in signatures (DEC:37-41; ARCH:83; RM:51).  
6. **Contracts are backend-owned** (packages/contracts); the frontend copy catches up, never the reverse; parity script must pass; one flat error envelope from every path including 404 and unhandled 5xx (DEC:51-71, 125-137; RM:52; P4X:239).  
7. **BLOCKED \= absent (404 by absence), never a 501 stub**, until its phase actually lands. A test asserts no 501 exists (DEC:81-88; RM:53; P4X:241).  
8. **Every write is idempotent (Idempotency-Key) and optimistically locked (If-Match).** Manifest-REQUIRED (RM:54; P4X:240; ARCH:146,162).  
9. **Compare-and-set in the adapter, not the service** (Firestore runTransaction); correctness must not depend on every call site remembering to check expectedVersion (DEC:267-291; P4X:242).  
10. **Cross-tenant access fails closed** (requireOrgAccess, IDOR-safe); owner/enumeration answers collapse to one error — never an existence oracle (RM:55; ARCH:138-139,160).  
11. **Access token in memory only; httpOnly cookie is backend-owned.** No tokens in localStorage; CSPRNG-derived from the Better Auth session (ARCH:167; P4X:243; DEC:11-16).  
12. **Money \= integer paise (minor units) everywhere on the wire.** applyPercent scales by 10 / divides by 1000, never float-multiplies; every breakdown must reconcile or fail loudly (P4X:245; P4:69-85; DREAM:1139).  
13. **FSMs are explicit tables.** Same-state transition \= idempotent no-op; anything unlisted throws; cancelled/terminal states are terminal; widen behaviour by walking edges, not loosening the table (ARCH:77,81; DEC:138-152).  
14. **Fail closed on missing config/keys/unknown state** — never a silent default or silent memory fallback (ARCH:156; P0:43; DREAM:311-322,357-361).  
15. **No secrets in logs or code** — pino redact; .env\* gitignored; never log passwords/tokens/API keys/PII (ARCH:157-158; MP:299-301).  
16. **No mocks / hardcoded responses in shipped code** ("rule 10"): if there is nothing real to return, do not register the route (DEC:127-129,220-222; P1:186).  
17. **Transactional outbox for multi-write fulfillment** — order \+ entitlements \+ promo \+ ledger in one atomic unit; consumers react async; no service-to-service calls (DEC:428,430-443; ARCH:150).  
18. **Serialize-to-response is re-validated against the zod schema** — schema mismatch → 500, never leak a raw document (ARCH:144-145,165).  
19. **Webhook HMAC verification is not optional** — validated at cold start, tampered payload → 400, deterministic serialization, idempotent claim (DEC:445-455).  
20. **Reconcile before deciding.** Documentation \= product/architecture intent; V2 frontend \= current client contract; V2 backend \= current implementation; legacy code \= proven behaviour reference only. "Explicitly record important conflicts before making destructive changes." (MP:103-115,995-1001; MP:317-325).  
21. **Priority order when rules conflict:** Correctness → Security → Architectural integrity → Maintainability → Testability → Performance → Convenience (MP:823-831).  
22. **Refactor god files; small files, single responsibility.** No 1,000-line controllers/services; "If existing code violates the architecture, refactor it into the correct modular structure." (MP:197-239,999-1001).  
23. **Definition of done ≠ "the code runs"** — docs satisfied, frontend contract satisfied, validation \+ security \+ consistent errors \+ tests \+ updated docs \+ independent review (MP:835-859).  
24. **Keep V1 and V2 fully separate** (parallel collections, v2\_\* prefix) and do not reintroduce reduced legacy fields (DEC:123; MP:377-399).  
25. **Append to decisions.md on every architectural decision; append a Session Log entry to the phase file before ending a session** — "do not rewrite history" (DEC:3-5; RM:27-30).

---

# **4\. CONTRADICTIONS BETWEEN THESE DOCS**

1. **Identity provider: Firebase vs Better Auth.** DREAM:371-378 (Stage 3\) and MLIP:332 (Stage 11\) both specify Firebase ID-token verification \+ /v2/session/sync. DEC:7 mandates Better Auth, "not ... Firebase." DEC:480 (D-024 C-4) itself flags the frozen manifest ("Firebase ID-token verification") vs middleware doc ("Better Auth") as "self-contradictory." **Resolved:** Better Auth wins (newer / more specific); the reference architecture docs were never updated.  
2. **Auth route family \+ shape.** DREAM:373,491 and MLIP:336 specify /v2/session, /v2/session/sync, /v2/session/logout ("Every application uses /v2/session"). Live backend ships /api/v2/auth/{signup,login,refresh,logout} \+ GET /auth/session (DEC:26-31; P0:77-83). DEC:477 (D-024 C-1): "the frozen session.\* names are superseded."  
3. **Success envelope.** Frozen planning docs / DREAM:167 / MLIP:226 imply a { data, meta } standard success envelope; DEC:478 (D-024 C-2) confirms the planning doc says { data, meta }. Live backend returns **bare DTO** / { items, pageInfo }. **Resolved** to bare DTO — but the reference docs still describe the wrapper.  
4. **Wire pagination scheme.** DREAM:937 and MLIP:785,1391,1831 mandate **cursor pagination** on the wire with hard max page sizes. DEC:89-95 (D-007) overrides: gateway emits **page-based** PageInfo{page,pageSize,total,hasNextPage}, "No cursor leaks to the client." Direct, unreconciled divergence (justified only by "mirror frontend").  
5. **Primary transactional datastore.** DREAM:33,2173 and MLIP:42,64 make **PostgreSQL** the authoritative transactional store at launch ("PostgreSQL owns transactional commerce and finance" is in the *final definition of success*). DEC:33-49 (D-002) ships Firestore first with Postgres "the destination ... later"; there is no Postgres in any phase 0–5. The shipped architecture does not meet the dream doc's own launch definition, and DREAM:33 lists "PostgreSQL \+ Firestore \+ Redis" as the launch stack when reality is Firestore-only (memory in CI, Redis injected/optional).  
6. **"One store" intent violated in practice.** DEC:154-189 (D-011): a parallel contributor shipped a **SQLite (node:sqlite)** durable adapter straight to origin/main with keyset pagination; it was reconciled back to Firestore but the SQLite adapter \+ its multi-adapter contract-suite pattern are still tracked as valuable un-ported work (DEC:174-180). The repo briefly had two competing durable stores.  
7. **Rate-limit class model is already stale.** DEC:482 (D-024 C-6) resolves "4 (middleware doc) vs 9 (manifest)" to a **4-class model** (PUBLIC\_READ 120 / AUTH\_READ 240 / STANDARD\_COMMAND 60 / SENSITIVE\_COMMAND 10 per 60s), echoed at ARCH:166. Later phase docs invent more classes: PAYMENT\_COMMAND (8/min) and WEBHOOK (P4X:135; P4:166-180), SCANNER\_COMMAND (300/min), DOOR\_COMMAND (60/min), COVER\_WALLET\_COMMAND (30/min) (P5:218). The "canonical 4" is contradicted by the roadmap.  
8. **Session rotation.** DEC:12 (D-001): "cookie-based sessions (httpOnly, SameSite, Secure-in-prod, **rotation enabled**)". DEC:494 (D-024 point 6): "7-day session / 1-day updateAge, **extend-in-place not rotate**." Direct contradiction within the same decisions log.  
9. **Phase-04 file contradicts itself.** P4:3 header: "Status: in progress (2026-08-14) — domain layer done, **wiring not started**." P4:133-205 (later session log) \+ RM:39: HTTP wiring complete, 302 tests, "done (2026-08-19)." The header was never updated.  
10. **Phase-05 file is partly corrupted / self-contradictory.** P5:3: "Status: **substantially done** (2026-08-21)"; P5:60 (an embedded diff-style duplicate of the file's own first half, lines \~58-114 carrying NN: prefixes): "**Status:** not started."  
11. **ROADMAP status table has been optimistic vs reality.** P5:269-275 records that an uncommitted ROADMAP.md edit claimed Phase 5 "done ... 29/29 contract tests pass" while **every route was returning 501** and the contract-suite test "never actually ran before — '29/29' was aspirational." P5:293-298 lists pre-existing bugs (core utils.ts didn't compile; buildActorContext failed \~95/122 gateway tests) — i.e. the P4X "contract suite passes against both Memory AND Firestore" exit gate (P4X:223) was not actually being enforced.  
12. **Client scope: dream vs reality.** DREAM:3-13 and MLIP:30-36 treat Partner Dashboard, Guest Portal, **Mobile App**, Scanner App, and Admin Console as five first-class clients. Reality: only partner-dashboard and guest-portal are real; admin-console is "an empty scaffold" (P7:5); there is no mobile-app repo and no scanner-app repo. The two big reference plans are scoped to a platform materially larger than what the roadmap builds.  
13. **Role model.** DREAM:528-548 (Stage 4\) prescribes a rich flat role list (OWNER/ADMIN/EVENT\_MANAGER/VENUE\_MANAGER/FINANCE\_MANAGER/MARKETING\_MANAGER/DOOR\_MANAGER/PROMOTER/VIEWER/PLATFORM\_ADMIN). Implementation collapses this to OrganizationRole {owner,admin,manager,member} × Capability {host,venue,promoter} plus a separate presentation-only PartnerRole, with user-token role ∈ {guest,partner,admin} (ARCH:79; P1:145-155; DEC:486 C-10). Deliberate simplification, but a documented model divergence ("two role vocabularies now coexist" — P1:153).  
14. **AGENTS.md status.** MP:118-149 declares the repo-root AGENTS.md outdated and non-authoritative — yet it still exists (13.5 KB at repo root) with no superseding pointer, so a new agent reading the repo top-down hits stale guidance first.  
15. **Outbox timeline vs mandate.** ARCH:150 and DEC:428 present the transactional outbox as a foundational, mandated invariant. DEC:46-49 (D-002) admits the Phase 0 Firestore adapter shipped with **no** transactional outbox (writes were "read-check-write"), and DEC:430-443 (D-021, dated 2026-08-17) still lists the Firestore outbox store as work "required before Phase 4 route activation." The mandated pattern lagged shipped code by four phases; P4's completion log (P4:157) describes a multi-write transaction without explicitly confirming the outbox event is inside it or that consumer/replay tests exist.

# **Circle1 V2 — Contract Layer, Gateway Middleware, Frontend Integration State**

Repo root: c:/Users/SHRIYASH SAWANT/OneDrive/Desktop/Circle1

Backend C1RCLE-BACKEND @ main 2a9a4b3; Frontend C1RCLE-FRONTEND @ staging df73e9b.

The single most authoritative digest already in the tree is C1RCLE-FRONTEND/docs/superpowers/FRONTEND-GATEWAY-BACKEND-MAP.md (written 2026-08-31 from live code). Everything below is cross-checked against actual source.

---

## **1\. WIRE CONTRACT (condensed)**

**Success envelope — bare DTO, no wrapper.** The response body *is* the zod-validated DTO (organizationDtoSchema, onboardingRequestDtoSchema, …). Lists are { items, pageInfo } (page-based: { page, pageSize, total, hasNextPage }). 204 has no body (noContentSchema). No { data, meta }.

Refs: C1RCLE-BACKEND/docs/api-contracts/error-contract.md:13-30, packages/contracts/src/contracts/shared.ts, docs/architecture/decisions.md D-004.

**Error envelope — flat, from every path** (incl. 404 via setNotFoundHandler, unhandled 5xx):

{ code, message, status, requestId, fieldErrors? }   // fieldErrors only on 400/422

code is a lowercase ApiErrorCode: validation | unauthorized | forbidden | not\_found | conflict | rate\_limited | server (gateway) \+ client-only network | timeout | aborted | parse | unknown (produced by @c1rcle/api-client). 5xx message is always "Internal server error"; real message logged with the requestId.

Refs: error-contract.md:33-63, C1RCLE-BACKEND/apps/api-gateway/src/app.ts:94-103, packages/contracts/src/index.ts:12-20 (buildV2ErrorResponse, STATUS\_CODE\_TO\_ERROR\_CODE, zodToFieldErrors).

**Status → frontend behavior:** 400/422 → map fieldErrors; 401 → one refresh() \+ replay once, else clear session \+ /login; 403 → permission-denied state identical whether or not the resource exists (IDOR-safe); 404 → not-found; 409 → refetch+resubmit with new version (or treat as already-done for idempotency conflict); 429 → honor Retry-After (seconds), bounded retry; ≥500 → generic retry (reads only).

Ref: error-contract.md:52-62, docs/api-contracts/auth-and-permissions.md (D-012 IDOR).

**Required request headers** (FRONTEND-GATEWAY-BACKEND-MAP.md:152-162):

| Header | When |
| ----- | ----- |
| Authorization: Bearer \<token\> | every authenticated call. Token \= Better Auth **session token** surfaced via the bearer() plugin's set-auth-token header — **not a minted JWT**. In memory only. |
| X-Organization-Id: \<opaqueId\> | every org-scoped route; **must equal the :organizationId path segment** (path is authoritative; mismatch → 403). Cache/rate-limit keys derive org from the verified actor, never the header. |
| X-Request-Id: \<uuid\> | every attempt; minted by @c1rcle/api-client; never carries token/PII. Gateway echoes or mints (apps/api-gateway/src/lib/request-tracing.ts:12-21). |
| Idempotency-Key | writes the route marks required (^\[A-Za-z0-9\_-\]{1,128}$). One key **per user intent**, stable across the client's internal retries — minted at the action call site, not per fetch (D-... / C-8). |
| If-Match: \<version\> | the 5 versioned PATCH/PUT: org update, venue update, venue profile, venue menu, event update. Value \= version from last read DTO; 409 on mismatch. |
| Content-Type: application/json | writes only; reads send no body. |
| x-csrf-token | BFF refresh / logout only — double-submit vs the non-httpOnly c1rcle.csrf cookie. |

**Rate classes — 4, sliding window / 60s** (C1RCLE-BACKEND/apps/api-gateway/src/plugins/rate-limit.ts:19-31):  
PUBLIC\_READ 120 · AUTH\_READ 240 · STANDARD\_COMMAND 60 · SENSITIVE\_COMMAND 10\.

Auth routes (/auth/signup, /auth/login, /auth/refresh) \= SENSITIVE\_COMMAND; /auth/session \+ reads \= AUTH\_READ; onboarding writes \= STANDARD\_COMMAND; verify-document \= SENSITIVE\_COMMAND. 429 carries retry-after in seconds (rate-limit.ts:63-68); @c1rcle/api-client honours it capped at 30s (packages/api-client/src/client.ts:125-126, errors.ts:15-28).

**Auth model — Better Auth (D-001):** httpOnly session cookie the backend owns (better-auth.session\_token, \_\_Secure- prefix in prod, SameSite=lax, httpOnly, host-only, 7-day expiresIn / 1-day updateAge; token string NOT rotated on refresh) \+ short-lived access token the client holds **in memory only**. Real auth requires STORAGE\_DRIVER=firestore; STORAGE\_DRIVER=memory (test/CI) fabricates a full-access dev actor and never 401s. role ∈ {guest, partner, admin}, server-set; /auth/signup forces partner. Per-org role/capability/tab-visibility comes from GET /organizations/:id/access (partnerAccessDtoSchema), **never** the token.

Refs: docs/api-contracts/auth-and-permissions.md:11-33, C1RCLE-BACKEND/apps/api-gateway/src/plugins/auth.ts:33-88.

**Auth routes (live):**

| Method | Path | Body | Response |
| ----- | ----- | ----- | ----- |
| POST | /api/v2/auth/signup | { email, password 8–128, displayName } .strict() — no role | 201 { user, accessToken, expiresAt } |
| POST | /api/v2/auth/login | { email, password } .strict() | 200 { user, accessToken, expiresAt } |
| POST | /api/v2/auth/refresh | none (cookie only) | 200 { user, accessToken, expiresAt } |
| POST | /api/v2/auth/logout | none | 204 \+ Set-Cookie clear (revokes server session) |
| GET | /api/v2/auth/session | none | 200 { user, expiresAt } or 401 |

user \= { id, email, displayName, role, avatarUrl: string|null } — **5 fields**. /auth/session returns **nothing else** — no memberships, activeOrg, permissions, KYC state. Those are separate calls: GET /api/v2/organizations → { items, pageInfo }; GET /api/v2/organizations/:id/access → partnerAccessDtoSchema; GET /api/v2/onboarding/me → { request | null }.

Ref: auth-and-permissions.md:20-47.

**Units:**

* Money \= integer **paise** (except platformFeePercent \= whole-number percent: basic→15, silver→12, diamond→10).  
* Timestamps \= **ISO-8601 strings** everywhere **except** Session.expiresAt and AdminAuditRecord.occurredAt \= **epoch milliseconds** (z.number().int().positive()). The parity script explicitly tests that an ISO-string expiresAt is *rejected* (C1RCLE-BACKEND/scripts/contract-parity.mjs:188-193, 256-261).  
* Opaque IDs: ^\[A-Za-z0-9\]\[A-Za-z0-9\_-\]\*$, ≤64 chars.

**PartnerPermission** is an 18-value enum: VIEW\_FINANCIALS, MANAGE\_STAFF, MANAGE\_EVENTS, EDIT\_EVENT\_RULES, MANAGE\_TABLES, VIEW\_GUESTLIST, SCAN\_ENTRY, LOG\_INCIDENTS, VIEW\_ANALYTICS, MANAGE\_SETTINGS, MANAGE\_PROMOTERS, MANAGE\_PAYOUTS, MANAGE\_PARTNERSHIPS, MANAGE\_PAGE\_CONTENT, VIEW\_REAL\_TIME\_SCANS, MANAGE\_GUEST\_OPS, CHARGE\_COVER\_WALLETS, EXPORT\_GUESTS. tabVisibility \=== null means "show all tabs". No actionPermissions, piiPolicy, or isSuspended field — suspension surfaces as a 403 from any org-scoped route.

Ref: auth-and-permissions.md:49-58.

---

## **2\. GATEWAY MIDDLEWARE CHAIN**

Registration order in C1RCLE-BACKEND/apps/api-gateway/src/app.ts:57-105: onRequestHook → cors (credentials, origins 3000/3001/3002) → validateV2Plugin → rbacPlugin (resolveActor: v2Services.actor) → rateLimitPlugin → cachePlugin → error handler / notFound handler → registerV2Routes.

**Global onRequest hooks (run in order):**

1. onRequestHook (lib/request-tracing.ts:19-21) — echoes x-request-id on the reply. Request id itself is minted/accepted by Fastify genReqId (request-tracing.ts:12-16).  
2. Better Auth context hook (plugins/auth.ts:112-165, registered via route-manifest.ts as authContextPlugin; **no-op entirely when auth is null, i.e. memory driver**):  
   * auth.api.getSession(headers) → on success sets request.user \= { uid } and request.authUser \= { id, platformRole }.  
   * Reads X-Organization-Id; **re-validates the opaque-id shape here** (^\[A-Za-z0-9\]\[A-Za-z0-9\_-\]\*$) before it can hit Firestore as a path separator (auth.ts:132-145).  
   * organizations.getMember(orgId, userId) → on a real membership sets request.authContext.activeMembership and request.actor \= { userId, organizationId, role, capabilities, platformRole }.  
   * lib/v2-services.ts buildActorContext reads request.actor synchronously afterwards. Memory driver: v2-services.ts:111-126 fabricates a full-access owner actor from the x-organization-id / x-user-id headers.

**Per-route preHandler chain** (Fastify decorators from the plugins above, applied in each route file's preHandler: \[...\] array):

rateLimit('\<CLASS\>')  →  validateV2({ params, querystring, headers, body })  →  requirePermission('\<verb\>')  →  cached('\<policy\>')  →  handler

* rateLimit(class) — plugins/rate-limit.ts: sliding-window in-memory counter keyed by verified actor/org/ip; on exhaustion replies 429 \+ retry-after seconds.  
* validateV2({...}) — plugins/validate-v2.ts: zod-validates params/query/headers/body against @c1rcle/contracts schemas; unknown keys → 422 with fieldErrors (.strict() schemas). Unknown-key on \_root.  
* requirePermission(verb) — plugins/rbac.ts: resolves the actor via the same resolveActor path as routes, checks the 18-verb PartnerPermission against membership role \+ capabilities; 403 (fail-closed, no existence oracle). Wired into every partner route family: organizations.ts (11), venues.ts (12), events.ts (6), event-catalog.ts (9), partnerships.ts (3), promoter-connections.ts (3), referral-links.ts (3), analytics.ts (2), plus admin/onboarding-review.ts, door/scanner-routes.ts.  
* cached(policy) — plugins/cache.ts: response cache keyed by verified actor \+ org. Wired only in partner/{analytics,organizations,venues}.ts so far.  
* Handler is **thin**: validateV2Response(reply, request, schema, dto) → reply.send. No .collection(), no business logic, no process.env (guardrail-enforced).

**Onboarding is the exception** (routes/v2/onboarding.ts:31-51): not org-scoped, **no X-Organization-Id, no requirePermission**; ownership checked against the session user id inside the service. Chain is just \[rateLimit, validateV2\] (+ runIdempotent in the handler for keyed writes).

Handler body → @c1rcle/core application service (requireOrgAccess tenant guard, emits domain events to the outbox in the same UoW) → pure domain model (FSMs, money \= integer paise, opaque IDs ≤64) → domain/ports/\* repository interfaces → infrastructure (Memory\*Repository for test/CI, Firestore\*Repository for dev/staging/prod; collections prefixed v2\_\*) → outbox → InProcessEventBus → audit \+ projection consumers (projection is no-op).

Ref: FRONTEND-GATEWAY-BACKEND-MAP.md:58-98.

---

## **3\. CONTRACT FLOW (backend owns, frontend imports)**

C1RCLE-BACKEND/packages/contracts/src/contracts/\*.ts        ← SINGLE SOURCE OF TRUTH  
   (auth, onboarding, organization, event, partner, checkout, phase5, shared)  
        │  node scripts/export-contracts.mjs \--frontend ../C1RCLE-FRONTEND  
        ▼  
C1RCLE-FRONTEND/packages/contracts/src/\*\*   GENERATED — every file carries a  
   \`// GENERATED by C1RCLE-BACKEND/scripts/export-contracts.mjs — do not edit\` header  
        │  tsc \-b tsconfig.build.json → dist/ (Next does not transpile workspace TS — FE ADR-0003)  
        ▼  
  @c1rcle/contracts          → ./dist/index.js   (domain schemas \+ types)  
  @c1rcle/contracts/client   → ./dist/client.js  (wire primitives \+ all domain re-exports)  
        │  
  @c1rcle/api-client/src/schemas.ts re-exports the shared primitives  
        ▼  
  apps import wire schemas ONLY from @c1rcle/contracts — no hand-written decoders

**export-contracts.mjs** (C1RCLE-BACKEND/scripts/export-contracts.mjs): copies packages/contracts/src/\*\*/\*.ts (excl. \*.test.ts, \*.d.ts) into \<frontend\>/packages/contracts/src/\*\*, prepending the GENERATED header; deletes generated files in the target whose backend source vanished (only touches files carrying the header); idempotent; \--dry-run supported. Syncs src/ **only** — never the FE package scaffolding.

**Parity check — contract-parity.mjs** (C1RCLE-BACKEND/scripts/contract-parity.mjs): **behavioural, not textual.** Loads BOTH repos' *built* schemas (\<fe\>/packages/contracts/dist/client.js \+ \<be\>/packages/contracts/dist/client.js), redirects the bare zod specifier so both build against one zod, then runs agree(schema, label, fixture, expected) asserting identical accept/reject on shared fixtures for: roleSchema, userSchema, sessionSchema (epoch-ms accepted / ISO rejected), pageInfoSchema, noContentSchema, paginatedSchema(), authBridgeResponseSchema, signupRequestSchema / loginRequestSchema (.strict(), role key rejected), onboardingProfileSchema (role rejected, unknown key rejected), onboardingRequestDtoSchema (pending status rejected), organizationDtoSchema, partnerAccessDtoSchema (tabVisibility: null accepted). Also diffs the status → code map (statusToErrorCode vs errorCodeForStatus) for 400/401/403/404/409/422/429/5xx/418, and probes that every FE ApiErrorCode is reachable through buildV2ErrorResponse. Exit 0 \= agree, 1 \= drift (CI fails), 2 \= cannot check (FE package not built — graceful, not a crash). \~59 checks; wired into both repos' pnpm check.

**End state (not done):** publish a versioned @c1rcle/contracts to a private registry; frontend pins it instead of vendoring the generated copy (D-003 / spec §5).

Current FE packages/contracts package (C1RCLE-FRONTEND/packages/contracts/package.json): name @c1rcle/contracts, exports . → ./dist/index.js and ./client → ./dist/client.js, only runtime dep zod 4.4.3. src/{index.ts, client.ts, contracts/{auth,checkout,event,onboarding,organization,partner,phase5,shared}.ts} all present with GENERATED headers. Landed on staging in commit ebe1df8 (Phase 2), regenerated fb45fc1 (doc-upload-url schemas).

---

## **4\. FRONTEND SURFACE INVENTORY — partner-dashboard routes by role**

Legend: **LIVE** \= gateway route \+ service real (firestore driver), FE just needs wiring · **MOCK** \= FE renders from baked-in fixture/model files or mock auth, backend exists → needs de-mock · **PARTIAL** \= backend route real but bare DTO lacks fields the screen wants (needs FE composition or a read-model) · **COMING-SOON** \= no /api/v2 route at all (BLOCKED, Phase 6/8).

Route tree from apps/partner-dashboard/src/app/\*\*; role shell config in src/components/partner-shell/config.ts (PARTNER\_SHELL\_CONFIG). Studio screens currently read hardcoded model files (components/venue/data.ts 454 lines, components/host/host-studio-model.ts, components/promoter/\*-model.ts) — NOT the repositories, except where noted. Only partnerRepositories (src/lib/partner/repositories.ts) touches the real gateway, and only for host.getOrganizations / host.getOverview / host.getEvents (via uncommitted WIP gateway-partner-transport.ts \+ api-partner-repositories.ts, gated by NEXT\_PUBLIC\_PARTNER\_USE\_REAL\_API); every other repo method \+ all of promoter is fixture-bound (repositories.ts:39-69).

### **Cross-role / auth journey**

| Route | Screen | Current data | Backend endpoint | Status |
| ----- | ----- | ----- | ----- | ----- |
| / | landing (app/page.tsx) | static | — | n/a |
| /login | login/PageClient.tsx (932 lines) — mock Firebase, Google popup, workspace picker | mock getFirebaseAuth() \+ /api/auth/\* | POST /api/v2/auth/login (via BFF) | **MOCK** (backend LIVE; BFF route app/api/auth/login/route.ts landed) |
| /signup | **does not exist** — folded into /onboard | — | POST /api/v2/auth/signup | **COMING-SOON (FE)** — planned, Anil's lane |
| /onboard | onboard/PageClient.tsx (2790 lines) — 6–7 step wizard, OTP, entity branching, full KYC | mock /api/auth/onboard\*, firebase/auth | /api/v2/onboarding/\* full set | **MOCK** (backend LIVE incl. doc upload-url 2a9a4b3) |
| /verify | verify/PageClient.tsx (1202 lines) — KYC hub, IFSC lookup to ifsc.razorpay.com | mock /api/kyc/\* \+ direct external fetch | none (bank/payouts \= Phase 6\) | **COMING-SOON** — route to be deleted (Majid's lane) |
| /partner/select-organization | partner/select-organization/page.tsx | fixture | GET /api/v2/organizations → { items, pageInfo } | **MOCK** (backend LIVE) |
| /partner-network/promoters/\[promoterId\] | PromoterNetworkProfile (decision profile, no finance fields) | partnerRepositories.\* fixture | promoter-connections \+ analytics | **MOCK** |

### **Venue Studio (/venue/\*) — nav: Overview, Events, Partners, Marketing, Finance, Settings**

| Route | Screen component | Backend | Status |
| ----- | ----- | ----- | ----- |
| /venue , /venue/overview | venue/screens/OverviewScreen ← venue/data.ts mock (1266-line-class mock per docs; 454 here) | GET /organizations/:id \+ .../analytics/overview (LIVE) | **PARTIAL** (screen wants composite HostOverview\-style payload) |
| /venue/events , /venue/events/analytics | VenueEventsExplorer / VenueEventsAnalyticsScreen ← mock | GET /organizations/:id/events , GET /events/:id/analytics (LIVE) | **MOCK → PARTIAL** (list LIVE; per-event rollups need N+1 or read model) |
| /venue/events/create , /venue/events/\[eventId\]/edit | CreateEventScreen / edit ← mock models | POST /organizations/:id/events , PATCH /events/:id (If-Match) — LIVE | **MOCK** (backend LIVE) |
| /venue/events/\[eventId\] (+ (detail)/{page,promoters,marketing,guests}) | detail screens ← event-detail-model.ts mock | GET /events/:id , /events/:id/{ticket-tiers,promo-codes,table-packages,promoter-assignments,referral-links} , state actions publish/pause-sales/resume-sales/cancel — LIVE | **MOCK** (backend LIVE; summary numbers PARTIAL) |
| /venue/events/\[eventId\]/(detail)/sales , .../finance | VenueEventSalesScreen / VenueEventFinanceScreen ← mock | none (orders/checkout) | **COMING-SOON** (Phase 6\) |
| /venue/partners | venue/screens/PartnersScreen (Discover/Requests/Connected) ← mock | GET/POST /organizations/:id/partnerships , /promoter-connections — LIVE | **MOCK** (backend LIVE) |
| /venue/slot-requests | SlotRequestsScreen ← mock | GET/POST /venues/:venueId/slot-requests — LIVE | **MOCK** (backend LIVE) |
| /venue/marketing | venue/screens/MarketingScreen ← mock | campaigns — none | **COMING-SOON** |
| /venue/finance , /venue/finance/orders | FinanceScreen / VenueOrdersScreen ← mock | none (finance/payouts/orders) | **COMING-SOON** (Phase 6 phase-06-finance-ledger-payouts.md) |
| /venue/settings | SettingsScreen ← mock | GET/PATCH /organizations/:id , .../members , .../invitations , GET/PATCH /venues/:id/{profile,menu} , calendar, availability — LIVE | **MOCK** (backend LIVE) |
| /venue/notifications | NotificationCenterScreen ← mock | none | **COMING-SOON** (Phase 8\) |
| /venue/door (tabs: scanner, guests, walk-ins) | venue/screens/DoorModeScreen ← venue-door-model.ts mock | POST /door/sessions, /door/lookup, GET /door/check-ins, /door/check-ins/verify, /door/walk-in, /door/dine-in, /door/sales, GET /tickets/:id/qr, /door/offline-sync, cover-wallets — **LIVE** | **MOCK** (backend mostly LIVE); POST /door/override, GET /door/offline-manifest, GET /door/stats, /door/stats/ws, cover-wallet freeze/unfreeze \= **honest 501** (Founder Tasks A2 \+ B) |

### **Host Studio (/host/\*) — nav mirrors Venue**

| Route | Screen | Backend | Status |
| ----- | ----- | ----- | ----- |
| /host , /host/overview | HostOverviewScreen ← host-studio-model.ts (hostEvents, hostPartners, hostSlotRequests, hardcoded trend arrays) | GET /organizations/:id \+ .../analytics/overview (LIVE) | **PARTIAL** — this is the one place a real call is wired: partnerRepositories.host.getOverview (uncommitted WIP), decoder returns GAP zeros for nextEvent/recentOrders/performance/calendar (api-partner-decoders.ts:246-285) |
| /host/events (+ create, \[eventId\]/{page,analytics,earnings,guests,marketing,promoters}, invitations, invitations/\[invitationId\], requests/\[requestId\]) | HostEventsScreen / HostEventDetailScreen etc. ← mock; getEvents wired to real GET /organizations/:id/events | events \+ catalog LIVE; earnings \= none | **MOCK / PARTIAL**; earnings **COMING-SOON** |
| /host/partners (+ promoters/\[promoterId\], venues/\[venueId\]) | HostPartnersScreen / HostPartnerProfileScreen ← mock | partnerships \+ promoter-connections LIVE | **MOCK** |
| /host/marketing | HostMarketingScreen ← mock | none | **COMING-SOON** |
| /host/finance , /host/finance/orders | HostFinanceScreen (uses partnerRepositories.host.getFinance → throwing stub notImplemented) | none | **COMING-SOON** (Phase 6\) |
| /host/settings | PartnerSettingsScreen ← partnerRepositories | org/members/invitations LIVE | **MOCK** |
| /host/notifications | Host\* notification ← mock | none | **COMING-SOON** (Phase 8\) |

### **Promoter Studio (/promoter/\*) — nav: Overview, Events, Partners, Finance, Links, Settings (no Marketing; primary action "Get link")**

| Route | Screen | Backend | Status |
| ----- | ----- | ----- | ----- |
| /promoter , /promoter/overview | PromoterOverviewScreen ← partnerRepositories.promoter.getOverview → **fixture** (fixture-promoter-repository.ts) | /promoter-connections, /events/:id/referral-links, /events/:id/analytics — LIVE, but promoter repo methods point at stale /api/v1/partner/promoter/\* paths | **MOCK** (adapter uses legacy v1 paths; all fixture) |
| /promoter/events , /promoter/events/\[eventId\] | PromoterEventsScreen / detail ← fixture | assignments \+ referral-links LIVE | **MOCK** |
| /promoter/partners | PromoterPartnersScreen ← fixture | promoter-connections LIVE | **MOCK** |
| /promoter/links | PromoterLinksTable / PromoterLinkBuilder ← fixture | GET/POST /events/:id/referral-links , POST /referral-links/:id/deactivate — LIVE | **MOCK** (backend LIVE) |
| /promoter/finance , /promoter/finance/orders | PartnerFinanceScreen / PartnerOrdersScreen ← fixture (private, no revenue in network profile) | none | **COMING-SOON** (Phase 6\) |
| /promoter/settings | PartnerSettingsScreen ← fixture | org/members LIVE | **MOCK** |

**Rollup:** \~0 routes truly LIVE-wired in production path (the 3 host WIP methods are uncommitted and flag-gated). Auth \+ onboarding \+ org/venue/event/partner/door screens are **MOCK over a LIVE backend** (the whole point of the current effort). Finance/orders, per-event sales, notifications, marketing/campaigns, host earnings, /verify bank \= **COMING-SOON** (no backend).

**Known vocab mismatch:** FE nav permission strings in config.ts (VIEW\_EVENTS, VIEW\_PARTNERS, VIEW\_MARKETING, VIEW\_FINANCIALS, CREATE\_TRACKING\_LINK) do **not** match the backend 18-verb partnerPermissionSchema (MANAGE\_EVENTS, VIEW\_ANALYTICS, …). Mock DashboardAuthProvider returns grantedPermissions: \['\*'\] so it never bites today (components/providers/DashboardAuthProvider.tsx:93,125,547). src/lib/rbac/types.ts is a separate FE-declared RBAC type set (keep only as render hints).

---

## **5\. EXISTING TEAM PLANS — assignments, completion, open items**

Two task docs, one plan, one spec, one handoff. Plan \= docs/superpowers/plans/2026-08-27-auth-foundation-plan.md (9 phases: 0 reference, 1 backend, 2–8 frontend). Spec \= .../specs/2026-08-27-frontend-gateway-auth-foundation-design.md. Slice scope \= **signup → login → onboarding/KYC → select organization → land in the correct partner studio**, fully de-mocked. Studio screen de-mock (spec C), guest-portal (D), admin-console (E), backend Phase 5 completion (track G) are explicitly **out of scope**.

### **DONE (verified against git log on staging)**

| Phase | Commit | Shipped | Verified |
| ----- | ----- | ----- | ----- |
| 1 — backend foundation | (folded into 2a9a4b3 / earlier) | packages/contracts build \+ export-contracts.mjs \+ contract-parity.mjs expanded; buildActorContext → UnauthorizedError; D-024 | scripts present & rich |
| 2 — contracts \+ api-client | ebe1df8 | FE @c1rcle/contracts generated mirror; @c1rcle/api-client gains reauth \+ Retry-After | packages/api-client/src/{client.ts:125,185-188,255; errors.ts:15-28; types.ts:30}, client.test.ts:132-179 |
| 3 — @c1rcle/auth | 0080cf7 \+ 3911c4c | compiled react-library: src/{session-store,auth-client,server-session,index}.ts \+ tests; refresh-stampede guard; Firebase shim deleted | packages/auth/src/\* present |
| 4 — auth BFF | ef27e1f | src/lib/bff/auth-proxy.ts \+ src/app/api/auth/{signup,login,refresh,logout,session}/route.ts (Origin/Sec-Fetch-Site check, double-submit CSRF, proto-pollution strip, cookie re-scope) | files present, auth-proxy.test.ts present |
| — | 2a9a4b3 (backend) | **Founder Task A1** — signed-URL issuing for onboarding KYC docs (ObjectStoragePort \+ EchoObjectStorage \+ FirebaseObjectStorage v4 signed PUT \+ POST /onboarding/applications/:id/documents/upload-url \+ schemas \+ 4 tests) | C1RCLE-BACKEND/apps/api-gateway/src/routes/v2/onboarding.ts:172-195 |
| — | f531d0d, fb45fc1 | doc-upload-url schemas regenerated to FE; INTERN-TASKS re-sliced | — |

### **OPEN — intern lanes (INTERN-TASKS-2026-08-27.md, assignment 2026-08-29). Each \= one branch off staging, one PR. Strict file ownership. Merge order Sagar → Keshvi → Anil → Majid.**

| Person | Lane | Plan phase | Key deliverables | State |
| ----- | ----- | ----- | ----- | ----- |
| **Sagar** | App shell \+ CSP | 5 Part A \+ Phase 8 CSP | src/proxy.ts (NOT middleware.ts) — per-request CSP nonce \+ auth redirect on /venue|/host|/promoter|/onboard|/partner|/partner-network; next.config.ts HSTS; src/components/providers/session-provider.tsx (hydrate \+ auth.refresh(), 30-min idle timer, focus-refresh); src/lib/api/client.ts (createApiClient composition root); src/lib/org/{active-org,org-repository}.ts; src/lib/access/use-org-access.ts; root layout.tsx; all packages/eslint-config \+ check-boundaries edits (ban firebase, add proxy.ts allowlist); delete raw process.env\['NEXT\_PUBLIC\_PARTNER\_\*'\] reads | **NOT STARTED** — no src/proxy.ts, no src/lib/{api,org,access}, no session-provider.tsx in tree |
| **Keshvi** | Org access \+ context migration | 5 Part B \+ Phase 6 (context) | src/lib/org/\*\*, src/lib/access/use-org-access.ts, rewrite partner/select-organization/page.tsx, re-home DashboardAuthProvider.tsx → session-context.tsx (\~40 useDashboardAuth() consumers; keep alias; map to @c1rcle/auth \+ useOrgAccess; drop isBanned/kycStatus/entityType/subscriptionPlan/actionPermissions/piiPolicy/mustChangePassword/30s poll) | **NOT STARTED** — DashboardAuthProvider.tsx (617 lines) still mock Firebase \+ /api/auth/\* fetch \+ 30s poll (:156,212,435) |
| **Anil** | Auth screens \+ mock-auth teardown | 6 | rebuild /login on auth.login() (remove Google/signInWithPopup/signInWithCustomToken/workspace picker); new /signup route on auth.signup(); **delete** src/lib/firebase/client.ts, src/lib/auth/getCachedFirebaseIdToken.ts, the 12 mock app/api/auth/\* routes (NOT the 5 BFF), /auth/change-password \+ /forgot-password links | **NOT STARTED** — lib/firebase/client.ts, lib/auth/getCachedFirebaseIdToken.ts, and all 12 mock routes (check-availability, check-email, create-account, me, onboard, onboard-status, onboarding-progress, otp/send, otp/verify, partner-context, profile) still present |
| **Majid** | Onboarding \+ KYC teardown | 7 | rebuild /onboard to V2 4-step wizard (type+plan → profile autosave PATCH → 3-doc real upload flow via upload-url → PUT → documents → submit); **delete** src/app/verify/\*\*, src/app/api/kyc/\*\*; remove firebase from package.json \+ .env.example (**the very last commit of the whole effort**) | **NOT STARTED** — app/verify/\*\*, app/api/kyc/{route,upload,verify-aadhaar} still present; apps/partner-dashboard/package.json still has firebase |
| **Shriyash** (lead) | Founder Task A2 \+ Phase 8 E2E \+ review every PR | Track G \+ Phase 8 | see below | A2 not started; Phase 8 blocked on lanes |
| **Ayush** (founder) | Founder Task B | Track G | see below | not started |

### **OPEN — Founder tasks (FOUNDER-TASKS-2026-08-29.md, repo C1RCLE-BACKEND @ main)**

* **Task A1 (Shriyash)** — onboarding doc upload-url — ✅ **DONE** 2a9a4b3.  
* **Task A2 (Shriyash)** — POST /door/override (new overridden terminal state on ScanLedgerStatus, denied → overridden FSM, ScannerService.overrideScan) \+ GET /door/offline-manifest (HMAC-SHA256 manifest — only ship if the verifying side in syncOfflineScans also ships). Honest 501s at door/scanner-routes.ts \~372 / \~399. **OPEN.**  
* **Task B1 (Ayush)** — cover-wallet freeze / unfreeze (CoverWalletStatus gains frozen, active↔frozen, charge/topUp/reconcile reject while frozen). 501s at cover-wallet-routes.ts \~301 / \~323. **OPEN.**  
* **Task B2 (Ayush)** — GET /door/stats read model (scans/door-sales/cover-wallet aggregates) \+ GET /door/stats/ws (needs @fastify/websocket, or keep as tighter 501). 501s in phase5-routes.ts; the current /door/stats returns a non-envelope { error } that must be fixed. **OPEN.**  
* **Task B3 (Ayush)** — fix the one pnpm boundaries violation: raw fetch() in packages/core/.../razorpay-adapter.ts → introduce HttpClientPort or move the adapter to apps/api-gateway/src/infrastructure/payments/. **OPEN.**  
* **Task B4 (Ayush)** — ratchet @c1rcle/core's \~909 no-explicit-any errors: turn the rule to error for new code, inventory existing, clear top \~50 in domain/. **OPEN.**

### **OPEN — deferred/follow-up (tracked, not in any lane)**

Password reset (/forgot-password \+ Better Auth reset endpoints); TanStack Query migration for partner-dashboard server-state (spec C); studio screen de-mock (spec C); guest-portal de-mock (spec D); admin-console (spec E); social/Google login.

### **Incident on record (HANDOFF-2026-08-27-auth-foundation.md:8-45)**

2026-08-28: an rm/git worktree remove following pnpm junctions on Windows destroyed \~8 days of uncommitted backend packages/{core,contracts} WIP; also revealed committed HEAD 162d1b7 was itself broken. Recovered and rebuilt (core green, 232 tests). Rule added: never cp \-r/rm \-rf/git worktree remove a tree containing node\_modules on Windows.

---

## **6\. chatgpt\_response.md verdict — STALE (generic architecture advice, pre-dates the stack decisions)**

C1RCLE-BACKEND/docs/reference/chatgpt\_response.md is a ChatGPT conversation rating an early "PLAN 1". It assumes a stack the project **did not adopt**: API Gateway \= **Kong** (live: Fastify 5, in-process — no Kong), DB \= **PostgreSQL** (live: Firestore, collections v2\_\*), React state \= **Redux Toolkit / RTK Query** (live: no Redux, no zustand — hand-rolled useSyncExternalStore; server-state via RSC \+ a bare useEffect fetch, TanStack Query available but unmounted in partner-dashboard), auth \= **JWT \+ refresh tokens** (live: Better Auth httpOnly cookie \+ in-memory *session token* via bearer(), not a minted JWT), rate limiting \= generic per-IP/per-user numbers (live: 4 named classes), plus Kafka/RabbitMQ \+ K8s \+ OpenSearch \+ full observability stack that don't exist. It also predates the corrected wire contract — it still references a { data, meta }\-ish envelope and packages/contracts "publish → frontend installs" as future.

**What's still worth keeping:** the *principles*, all of which the real build already honours — modular monolith over microservices, thin routes (validate → auth → policy → service → serialize), backend-owned contracts, controlled V1→V2 parallel with parity tests, outbox pattern, explicit FSMs for event/scan/wallet lifecycles, config isolation (packages/core never reads process.env), idempotency keys per intent, optimistic locking (If-Match \+ version), repository interfaces with memory \+ real adapters. FRONTEND-GATEWAY-BACKEND-MAP.md:380 reaches the same conclusion. Treat it as background reading, never as a spec; the binding authority order is: master prompt → C1RCLE-BACKEND/docs/architecture/decisions.md → live code (route-manifest.ts, packages/contracts/src, packages/core) → the FE design spec → docs/api-contracts/\* (corrected 2026-08-29) → roadmap phase docs → everything else reference.

---

## **7\. Key file references**

**Backend contract/gateway:**

* C1RCLE-BACKEND/docs/api-contracts/{auth-and-permissions,error-contract,frontend-backend-matrix}.md  
* C1RCLE-BACKEND/apps/api-gateway/src/app.ts:57-105 (plugin order), plugins/{auth.ts:112-165, rate-limit.ts:19-31, validate-v2.ts, rbac.ts, cache.ts}  
* C1RCLE-BACKEND/apps/api-gateway/src/routes/v2/{route-manifest.ts, onboarding.ts, auth/index.ts, partner/\*.ts, door/\*.ts, admin/\*.ts}  
* C1RCLE-BACKEND/apps/api-gateway/src/lib/{request-tracing.ts, v2-services.ts:111-126}  
* C1RCLE-BACKEND/packages/contracts/src/contracts/\*.ts (source of truth)  
* C1RCLE-BACKEND/scripts/{export-contracts.mjs, contract-parity.mjs}

**Frontend:**

* C1RCLE-FRONTEND/docs/superpowers/FRONTEND-GATEWAY-BACKEND-MAP.md (master digest), INTERN-TASKS-2026-08-27.md, FOUNDER-TASKS-2026-08-29.md, HANDOFF-2026-08-27-auth-foundation.md, specs/2026-08-27-...-design.md, plans/2026-08-27-auth-foundation-plan.md  
* C1RCLE-FRONTEND/docs/architecture/README.md (three laws \+ single owners), adr/0003-compiled-packages.md  
* C1RCLE-FRONTEND/docs/partner-dashboard-backend-handoff.md, partner-dashboard-role-integration.md  
* C1RCLE-FRONTEND/packages/contracts/{package.json, src/{index.ts, client.ts}}  
* C1RCLE-FRONTEND/packages/api-client/src/{client.ts, errors.ts, types.ts, schemas.ts}  
* C1RCLE-FRONTEND/packages/auth/src/{session-store,auth-client,server-session,index}.ts  
* C1RCLE-FRONTEND/apps/partner-dashboard/src/lib/bff/auth-proxy.ts \+ src/app/api/auth/{signup,login,refresh,logout,session}/route.ts (real BFF)  
* apps/partner-dashboard/src/lib/partner/{repositories.ts, api-partner-repositories.ts, api-partner-decoders.ts, gateway-partner-transport.ts, contracts.ts, fixture-\*-repository.ts}  
* apps/partner-dashboard/src/components/partner-shell/{config.ts, partner-role-routing.ts, PartnerDashboardLayout.tsx}  
* apps/partner-dashboard/src/components/providers/DashboardAuthProvider.tsx (617 lines, mock — to be re-homed)  
* Mock to delete: apps/partner-dashboard/src/lib/firebase/client.ts, src/lib/auth/getCachedFirebaseIdToken.ts, src/lib/rbac/types.ts, 12 routes under src/app/api/auth/, 3 under src/app/api/kyc/, src/app/verify/\*\*  
* Baked-in studio fixtures: apps/partner-dashboard/src/components/venue/data.ts, .../host/host-studio-model.ts, .../promoter/\*-model.ts

Agent 1 (backend design intent) done — full target architecture, phase DoD 00–08, 25 non-negotiable rules, 15 doc contradictions captured. Waiting on agents 2 and 3\.

Agent 3 (contracts \+ gateway \+ FE integration) done. Critical finding: **every intern lane from the 2026-08-29 plan is NOT STARTED** — the uncommitted tree WIP (gateway-partner-transport.ts) is a separate, unmerged host-repo de-mock experiment. All 6 founder sub-tasks (A2, B1–B4) also open. Waiting on agent 2 (backend build-state vs design).

# **C1RCLE-BACKEND: Implementation vs Design Gap Analysis**

Repo: c:/Users/SHRIYASH SAWANT/OneDrive/Desktop/Circle1/C1RCLE-BACKEND · monorepo \= apps/api-gateway (Fastify 5\) \+ packages/core (domain/application/infrastructure) \+ packages/contracts (Zod). Storage behind ports, driver-swapped memory/firestore via buildRepositories (packages/core/src/infrastructure/utils.ts:92).

## **0\. Headline**

* **Phases 0–3**: LIVE. Matches design.  
* **Phase 4 (checkout/orders/payments/tickets/discovery)**: domain \+ services \+ adapters \+ contracts exist and CheckoutService is wired (apps/api-gateway/src/lib/v2-services.ts:270), but **every HTTP route is gone** — lost in the "Windows junction recursive delete" incident described in recovery commit 7e2d6c9; the recovery restored packages/core/packages/contracts only. ROADMAP.md:39 and docs/roadmap/phase-04-guest-checkout-tickets.md:133-204 still claim "done, HTTP wiring complete, 302 tests pass" — **false against the current tree.**  
* **Phase 5 (door/scanner/cover-wallet)**: substantially LIVE now — the PHASE\_5\_AUDIT\_REPORT.md (3.5/10, "all 25 routes return 501") is **stale**. Superseded by docs/PHASE\_5\_HTTP\_WIRING\_PLAN.md \+ commits 162d1b7/7e2d6c9. Real routes now in apps/api-gateway/src/routes/v2/door/{scanner,door-sale,cover-wallet}-routes.ts wired to real services. 6 honest 501s remain.  
* **Phases 6 (finance/ledger/payouts), 8 (social/notifications)**: zero backend. **Phase 7 (admin console)**: only the Phase-2 authority slice exists.  
* **Quality gates**: pnpm lint **FAILS** (core no-explicit-any), pnpm boundaries **FAILS** (1 violation), pnpm test has 1 known failure. pnpm check cannot pass. Phase 5 domain models have **0 unit tests**.

---

## **1\. Per-domain status table**

Route counts \= handlers registered under /api/v2 via apps/api-gateway/src/routes/v2/route-manifest.ts. "svc/domain/adapter" \= real implementation present (not stub). Tests \= dedicated \*.test.ts.

| Domain | Routes reg. | Service impl? | Domain/FSM impl? | Adapter (mem/fs) | Tests | Status |
| ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| **auth** | 5 (auth/index.ts) | Better Auth bridge; real only on firestore driver (route-manifest.ts:40) | identity in packages/core/src/domain/identity.ts | n/a (better-auth-firestore) | auth/index.test.ts | **LIVE** (memory driver fabricates actor — v2-services.ts:119) |
| **onboarding / KYC** | 8 (onboarding.ts) | OnboardingService 424 LOC | domain/models/onboarding.ts 269, FSM draft→submitted→approved/rejected/changes\_requested | mem memory-onboarding-repository.ts \+ firestore-onboarding-repository.ts | domain/onboarding.test.ts, routes/v2/onboarding.test.ts | **LIVE**; verification \= format-check stub by design (D-018); signed upload URLs added 2a9a4b3 |
| **organizations** | 11 (partner/organizations.ts) | OrganizationService 275 | domain/models/organization.ts 380 | mem memory-repositories.ts:104 \+ firestore-organization-repository.ts | organizations.test.ts, invitations.test.ts, idempotency.test.ts | **LIVE**; member invites token/expiry \= follow-up (V1\_TO\_V2\_PARITY.md:70) |
| **venues** | \~13 (partner/venues.ts) | VenueService 244 \+ VenueCalendarService \+ VenueSlotRequestService | domain/models/venue.ts 348 | mem memory-repositories.ts:148 \+ firestore-venue-repository.ts, firestore-venue-slot-repository.ts, firestore-slot-request-repository.ts | domain/availability.test.ts, domain/menu.test.ts — **no route test file** | **LIVE**; slot **countering** NOT implemented (V1\_TO\_V2\_PARITY.md:19); photos/cover/hours write surface pending |
| **events** | 7 (partner/events.ts) | EventService 204 | domain/models/event.ts 200, FSM draft→review→scheduled→published (+cancelled) | mem \+ firestore-event-repository.ts | partner/events.test.ts, domain/domain.test.ts | **LIVE** |
| **catalog** (tiers/promos/tables/promoter-assign) | 9 (partner/event-catalog.ts) | EventCatalogService 189 | domain/models/event-catalog.ts 311 | mem memory-repositories.ts:208 \+ firestore-event-catalog-repository.ts | partner/event-catalog.test.ts | **LIVE** |
| **analytics** | 2 (partner/analytics.ts) | AnalyticsService **56 LOC — read-model only** | none (read models) | MemoryAnalyticsReadModelRepository (memory-repositories.ts:284) \+ firestore-analytics-read-model-repository.ts | partner/analytics.test.ts | **PARTIAL** — serves precomputed aggregates; nothing writes them (write-time projection consumer is a no-op, v2-services.ts:170). Real numbers blocked on Phase 6 ledger |
| **partnerships** | 3 (partner/partnerships.ts) | PartnershipService 159 | domain/models/partnership.ts 225 (commission tiers ported) | mem memory-partnership-repository.ts \+ firestore-partnership-repository.ts | domain/partnership.test.ts, partner/partnerships.test.ts | **LIVE** |
| **promoter-connections** | 3 (partner/promoter-connections.ts) | PromoterConnectionService 129 | domain/models/promoter-connection.ts 170 | mem memory-promoter-connection-repository.ts \+ firestore-promoter-connection-repository.ts | domain/promoter-connection.test.ts, partner/promoter-connections.test.ts | **LIVE** |
| **referral-links** | 3 (partner/referral-links.ts) | ReferralLinkService 126 | domain/models/referral-link.ts 136 | mem memory-referral-link-repository.ts \+ firestore-referral-link-repository.ts | domain/referral-link.test.ts, partner/referral-links.test.ts | **LIVE** |
| **admin** (authority/onboarding-review/proposals/audit) | 11 (admin/onboarding-review.ts) | AdminAuthorityService 336 | domain/models/admin-authority.ts 241, TIER1/2/3 \+ propose→resolve dual control | MemoryAdminAuditRepository / FirestoreAdminAuditRepository (+ PlatformAdminRepository, ProposedActionRepository mem+fs) | domain/admin-authority.test.ts | **LIVE** for Phase-2 scope only; full Phase-7 console NOT started (see §4) |
| **door-scanner** (sessions/check-ins/lookup/verify/offline-sync/magic-QR) | 10 (door/scanner-routes.ts) — **8 live \+ 2 honest 501** | ScannerService 798 (createScannerService) | domain/models/scan-ledger.ts 258 \+ event-code.ts 274; FSM pending→consumed/denied/cancelled/expired→revoked; magic-QR HMAC ±65s | mem memory-scan-ledger-repository.ts, memory-event-code-repository.ts \+ firestore-scan-ledger-repository.ts, firestore-event-code-repository.ts | route door/scanner-routes.test.ts; repos in infrastructure/contract-suite.test.ts — **NO domain-model unit tests** | **PARTIAL/LIVE** — /door/override \+ /door/offline-manifest are 501 |
| **door-sales** (walk-in/dine-in/list) | 3 (door/door-sale-routes.ts) — all live | DoorService 373 (createDoorService), server-side price recalc via pricing | domain/models/door-sale.ts **128 LOC, incomplete** (unused InvalidOperationError, bumpVersion imports; createDoorSale(): any) | mem memory-door-sale-repository.ts \+ firestore-door-sale-repository.ts | route door/door-sale-routes.test.ts — no domain test | **LIVE** (void/refund FSM likely unfinished) |
| **cover-wallet** (issue/get/debit/credit/terminate/reconcile) | 8 (door/cover-wallet-routes.ts) — **6 live \+ 2 honest 501** | CoverWalletService 937 (createCoverWalletService); velocity 3/min, nightlife termination, paise-only | domain/models/cover-wallet.ts 235 \+ cover-wallet-reconciliation.ts 141 | mem memory-cover-wallet-repository.ts (+txn \+reconciliation) \+ firestore-cover-wallet-repository.ts (reconciliation folded in, :451) | route door/cover-wallet-routes.test.ts; repos in contract-suite.test.ts — **NO domain-model unit tests** | **PARTIAL/LIVE** — freeze/unfreeze are 501 (no service method) |
| **live door stats \+ WS** | 2 (phase5-routes.ts) — **both 501** | none | none | none | app.test.ts asserts 404-not-501 for blocked slices | **STUB-501** — needs @fastify/websocket \+ cross-source aggregation design |
| **Phase 4: orders** | **0** | domain order.ts 280 (FSM, dual-path markPaid) | yes | MemoryOrderRepository (memory-repositories.ts:348) \+ firestore-order-repository.ts | domain/order.test.ts (11) | **NO BACKEND (HTTP)** — domain LIVE, unreachable |
| **Phase 4: checkout** | **0** | CheckoutService 276 (wired v2-services.ts:270) \+ PricingService 53 \+ InventoryService 76 | pricing.ts 215 (18 tests), cart-reservation.ts 120 | mem MemoryCartReservationRepository \+ firestore-cart-reservation-repository.ts | domain/pricing.test.ts — **no service/route test** | **NO BACKEND (HTTP)** — service LIVE, unreachable |
| **Phase 4: payments** | **0** | RazorpayPaymentProvider — **in packages/core/src/application/payments/razorpay-adapter.ts 226 (boundary violation, uses fetch)** \+ duplicate at apps/api-gateway/src/lib/payments/razorpay-adapter.ts | webhook HMAC verify (D-022) | n/a | none | **NO BACKEND (HTTP)** — no /webhooks/payments/razorpay route |
| **Phase 4: tickets / entitlements** | **0** | issuance in CheckoutService fulfillment | entitlement.ts 174, deterministic ENT-{orderId}-{tierId}-{index}, scanCountAllowed | MemoryEntitlementRepository (:388) \+ firestore-entitlement-repository.ts | **no test** for entitlement.ts | **NO BACKEND (HTTP)** — no /tickets/\*, /wallet/\* routes |
| **Phase 4: discovery/public** | **0** | reads would reuse event/venue/org services | n/a | n/a | none | **NO BACKEND** — no /public/\* routes; guest portal still 100% fixtures |
| **Phase 6: finance / ledger / payouts / bank-accounts / disputes** | **0** | none | none | none | none | **NO BACKEND** |
| **Phase 7: admin console** (venue suspend, refund approval, payout batch, commission adjust, reprovision, support tickets, safety reports, announcements) | 0 (only Phase-2 subset) | AdminAuthorityService covers authority only | authority model only | admin-audit adapters only | admin-authority.test.ts | **NO BACKEND** for console features |
| **Phase 8: notifications / social / follow / chat** | **0** | none — "no mail transport exists in V2" (WORK-REPORT-2026-08-14-sagar.md:242) | none | none | none | **NO BACKEND** |

Approx. **101 route handlers registered** under /api/v2; **6 are honest 501 stubs** (below); \~95 functional.

---

## **2\. Every 501 / notImplemented / TODO (file:line)**

Complete list. There are **no** TODO, FIXME, XXX, HACK, @ts-ignore, @ts-expect-error, or eslint-disable anywhere in \*.ts (verified). Only 6 501s, all deliberate \+ tested:

| \# | Endpoint | File:line | Reason (from code comment) |
| ----- | ----- | ----- | ----- |
| 1 | GET /api/v2/door/stats | apps/api-gateway/src/routes/v2/phase5-routes.ts:20-22 | live stats aggregation across scanner+door+wallet undesigned |
| 2 | GET /api/v2/door/stats/ws | apps/api-gateway/src/routes/v2/phase5-routes.ts:29-32 | @fastify/websocket not registered on the app |
| 3 | POST /api/v2/door/override | apps/api-gateway/src/routes/v2/door/scanner-routes.ts:381-397 (501 at :391) | ScanLedgerStatus FSM has no denied → consumed transition; no ScannerService method |
| 4 | GET /api/v2/door/offline-manifest | apps/api-gateway/src/routes/v2/door/scanner-routes.ts:405-419 (501 at :411) | no ScannerService method signs a manifest; no verification path |
| 5 | POST /api/v2/cover-wallets/:walletId/freeze | apps/api-gateway/src/routes/v2/door/cover-wallet-routes.ts:301-317 (501 at :307) | CoverWalletService has terminateWallet/closeWallet but no freeze |
| 6 | POST /api/v2/cover-wallets/:walletId/unfreeze | apps/api-gateway/src/routes/v2/door/cover-wallet-routes.ts:323-339 (501 at :329) | no unfreeze service method |

Tests pinning these: door/scanner-routes.test.ts:244,256; door/cover-wallet-routes.test.ts:190; app.test.ts:26 (asserts blocked slices 404, never 501).

Loosely-typed domain functions (design-doc says "Domain Layer Pure", these undercut it — any return types, not stubs but not finished either):

* packages/core/src/domain/models/door-sale.ts:96 — createDoorSale(input): any  
* packages/core/src/domain/models/event-code.ts:84 — createEventCode(input): any  
* packages/core/src/domain/models/event-code.ts:157,201,208,243 — permissions: any, getSessionPermissions(codeType: any): any

---

## **3\. Phase 5 gap: audit report vs live code**

The PHASE\_5\_AUDIT\_REPORT.md (2026-08-20, score 3.5/10) is **superseded**. Its 10 "critical blockers" against current tree:

| Audit blocker | Current reality |
| ----- | ----- |
| "Zero Phase 5 contracts" | **CLOSED** — packages/contracts/src/contracts/phase5.ts exists (referenced by scanner-routes.ts:4-11, client.ts re-exports) |
| "Zero Phase 5 repository implementations" | **CLOSED** — 6 memory \+ 4 firestore adapters exist; wired in buildRepositories (utils.ts:117-121,159-163) |
| "All 25 HTTP routes return 501" | **MOSTLY CLOSED** — 3 route files, \~17 live handlers; only 6 x 501 remain (§2) |
| "Zero unit tests for Phase 5" | **PARTIAL** — repo contract suite (infrastructure/contract-suite.test.ts, ScanLedger/EventCode/ScannerSession/DoorSale/CoverWallet/Txn/Reconciliation) \+ 3 route test files. **Still zero domain-model unit tests** for scan-ledger.ts, event-code.ts, door-sale.ts, cover-wallet.ts, cover-wallet-reconciliation.ts (audit §3 "0/5" still true) |
| "Scanner auth (D-022) missing" | **NOT DONE, re-scoped** — routes auth via Better Auth cookie like every other v2 route (PHASE\_5\_HTTP\_WIRING\_PLAN.md:53-59); device bearer-token is an explicit follow-up. Doc notes "D-022 was a misattribution — real D-022 is Razorpay webhooks" |
| "WebSocket live stats missing" | **STILL MISSING** — 501 (§2 \#2) |
| "Magic Ticket QR not implemented" | **CLOSED** — GET /tickets/:ticketId/qr live (scanner-routes.ts:499), generateMagicTicketQr \+ HMAC 30s window in scanner-service.ts (added in 7e2d6c9) |
| "Offline support missing" | **HALF** — POST /door/offline-sync live (scanner-routes.ts:428); GET /door/offline-manifest still 501 |
| "No contract parity tests" | Historically 33/33 (WORK-REPORT-2026-08-14-sagar.md:271); not re-verifiable here |
| "Rate limit classes undefined" | Routes use fastify.rateLimit('AUTH\_READ') etc. (phase5-routes.ts:18); dedicated SCANNER\_COMMAND/DOOR\_COMMAND/COVER\_WALLET\_COMMAND classes not confirmed |

**What's left to call Phase 5 "done"** (per docs/roadmap/phase-05-door-scanner-cover-wallet.md:306-319 Session Log \+ HTTP wiring plan):

1. Live door stats GET /door/stats \+ WebSocket /door/stats/ws — needs @fastify/websocket registration \+ aggregation design across scanner/door/wallet.  
2. POST /door/override — ScanLedger FSM needs a denied → consumed (or override) transition \+ ScannerService.overrideDenied.  
3. GET /door/offline-manifest — a service method that produces a **signed** manifest \+ its verification counterpart.  
4. cover-wallet freeze/unfreeze — add freezeWallet/unfreezeWallet to CoverWalletService (distinct from terminate).  
5. Real scanner-device bearer-token auth layer (short-lived signed token from staff login) — currently cookie-session only.  
6. **5 domain-model unit test files** (FSM transitions, processEntryScan idempotency, magic-QR ±65s drift, wallet debit/credit atomicity \+ velocity \+ nightlife termination).  
7. Known un-fixed logic debt in scanner-service.ts: ScannerSession.organizationId set to creating actor's id not real org (worked around at route layer); scanTicket/scanMagicTicket read client deviceId as a session-token lookup key, not hardware id (phase-05 Session Log :313-319).  
8. Clean up door-sale.ts (unused imports ⇒ void/refund FSM unfinished) and remove : any domain return types.

---

## **4\. Phases 6–8 gap: what has zero backend \+ what the roadmap requires**

### **Phase 4 (regression — treat as re-work, not new)**

Zero HTTP surface. Roadmap phase-04 §"Session Log 2026-08-19" lists what existed and must be **restored**: POST /checkout/quote, /checkout/holds, POST /payments/attempts, POST /payments/:id/verify, GET|POST /orders, GET /orders/:id\[/status\], GET /tickets/:id, POST /tickets/:id/{transfer,claim,cancel-transfer}, GET /wallet\[/tickets|/orders\], POST /webhooks/payments/razorpay, GET /public/{events,events/:idOrSlug,venues/:slug,hosts/:slug,discovery,search}. Domain/services/adapters/contracts are intact; this is a route-layer rebuild \+ moving razorpay-adapter.ts out of packages/core (§5).

### **Phase 6 — Finance / Ledger / Payouts (docs/roadmap/phase-06-finance-ledger-payouts.md) — nothing exists**

* Port **System A** (finance-service.ts / partner\_ledger), not System B. Single writer recordTicketSale(eventId, orderId, gross, {venueId, hostId, promoterId?, rates}) called from checkout confirmation; one idempotent transaction (partner\_ledger\_idempotency/{orderId}).  
* Split formula: platformFee \= round(gross\*rate), venueShare, promoterCommission (0 if no promoter), hostPayout \= gross − others. Rates parameterized per-venue from onboarding plan tier (basic 15 / silver 12 / diamond 10 — already in domain/models/onboarding.ts).  
* Balances always computed from ledger; denormalized partner\_finance\_aggregates/{partnerId} maintained by increment, rebuildable by scan. "No cache-ledger drift."  
* Promoter leaderboard stats increment in same txn (leaderboard\_stats/..., all\_time/month/week × global/city).  
* T+3 settlement eligibility gate (lifecycle==='completed' AND updatedAt\<=now-3d AND settlementStatus==='pending').  
* Minimum promoter payout ₹100. Bank accounts: last4 plaintext \+ full number encrypted, one isDefault. Refunds: verify current thec1rcle actually calls Razorpay refund API before porting.  
* New collections: v2\_partner\_ledger, v2\_partner\_ledger\_idempotency, v2\_partner\_finance\_aggregates, v2\_payouts, v2\_bank\_accounts, v2\_disputes, v2\_leaderboard\_stats.  
* Unblocks: Phase 1 finance dashboard endpoints (deferred, ROADMAP.md:36), real analytics numbers.

### **Phase 7 — Admin console (docs/roadmap/phase-07-admin-console.md) — authority layer only exists**

* Have: TIER1/2/3, propose→resolve dual control, before/after audit (AdminAuthorityService, routes admin/onboarding-review.ts).  
* Need: venue suspend, financial refund approval, payout batch run, commission adjustment (TIER3), admin provisioning (exists partially via /admin/proposals/:id/provision-admin), partnerReprovision() (deactivate old memberships \+ recreate correct entity/membership/claims), support tickets, safety reports, platform announcements.  
* Depends on Phase 6 for financial actions. New collections: v2\_support\_tickets, v2\_safety\_reports, v2\_platform\_announcements.  
* Frontend apps/admin-console is an empty scaffold — backend-first.

### **Phase 8 — Social / discovery / notifications (docs/roadmap/phase-08-social-notifications.md) — nothing; lowest priority**

* No mail/notification transport in V2 at all (blocks Phase 2 approval emails too).  
* If started: follow graph (v2\_follows, fan-out "new event" notifications), notifications (v2\_notifications, v2\_notification\_reads), then chat (eventGroupMessages, privateConversations, directMessages, typingIndicators, userBlocks, userReports).  
* Roadmap: "Do not start until Phases 0–7 are live"; no frontend need today.

---

## **5\. Quality debt**

### **Failing / broken gates (package.json:20 — check \= format:check && lint && typecheck && boundaries && test && build)**

1. **pnpm lint — FAILS.** eslint.config.mjs:62 sets @typescript-eslint/no-explicit-any: 'error' (+ no-unsafe-\*, no-non-null-assertion) globally; strictTypeChecked \+ stylisticTypeChecked enabled (:33-34); reportUnusedDisableDirectives: 'error' (:47); **no per-file disables exist anywhere**. packages/core has "lint": "eslint ." (packages/core/package.json). Direct run of eslint on just 2 Phase-5 files \= **62 errors**:  
   * packages/core/src/application/cover-wallet/cover-wallet-service.ts — \~40 errors: no-explicit-any (:256-258,315,355,695,813), no-unsafe-argument (audit records / PaginationQuery), no-non-null-assertion (\~15), no-unnecessary-type-assertion.  
   * packages/core/src/domain/models/door-sale.ts — no-explicit-any (:96) \+ 2 unused-imports/no-unused-imports (InvalidOperationError :1, bumpVersion :2).  
   * Same pattern across scanner-service.ts (:206,249-250,296,338-339,370-487,536), event-code.ts (:84,157,201,208,243), memory-cover-wallet-repository.ts (:33-38,98,103), memory-cover-wallet-reconciliation-repository.ts, memory-scan-ledger-repository.ts (:28,31), firestore-cover-wallet-repository.ts (:382-483,628,655,672), door-service.ts (:111,318), cover-wallet.ts (:60,104).  
   * Acknowledged as "the pre-existing @c1rcle/core any lint debt" in recovery commit 7e2d6c9 — a Phase-5-recovery-was-rushed artifact.  
2. **pnpm boundaries — FAILS (1 violation).** scripts/check-boundaries.mjs Rule 2: "raw fetch() in core package (forbidden)". packages/core/src/application/payments/razorpay-adapter.ts:67,120,148,178 calls fetch(). Should live in apps/api-gateway/src/lib/ (where a duplicate already is). Confirmed in 7e2d6c9 commit message ("boundaries \= 1 pre-existing violation only") and PHASE\_5\_AUDIT\_REPORT.md:79.  
3. **pnpm test — 1 known failure.** packages/core/src/infrastructure/compare-and-set.test.ts — "pre-existing/unrelated, explicitly called out as known" (docs/roadmap/phase-05-door-scanner-cover-wallet.md:301-304). Otherwise \~231/232 core, \~122–125 gateway green.  
4. **pnpm typecheck — passes but SOFT.** tsc \--noEmit succeeds only because any return types (door-sale.ts:96, event-code.ts:84) and as any casts mask real type holes. The compiler is not enforcing the domain contracts the design assumes.

⇒ **pnpm check (and thus CI pnpm check) cannot currently pass.** Every "verified green" claim in the phase docs predates the Phase-4-loss / Phase-5-recovery and is no longer reproducible.

### **Missing tests**

* **Phase 5 domain models: 0 unit tests** — scan-ledger.ts, event-code.ts, door-sale.ts, cover-wallet.ts, cover-wallet-reconciliation.ts. (Repos are covered by infrastructure/contract-suite.test.ts; FSM/velocity/HMAC logic is not.)  
* **Application services: only 2 have tests** — application/idempotency/idempotency-service.test.ts, application/events/event-bus.test.ts (\~12 cases total). No direct unit tests for ScannerService, DoorService, CoverWalletService, CheckoutService, PricingService, InventoryService, AnalyticsService, OrganizationService, VenueService, EventService, EventCatalogService, PartnershipService, AdminAuthorityService, OnboardingService. Scanner/door/cover-wallet get indirect coverage via route tests; **CheckoutService gets none** (routes gone).  
* **No route test for partner/venues.ts** (the largest partner route file, \~13 handlers).  
* **Phase 4 domain**: entitlement.ts and cart-reservation.ts have no dedicated test (order.ts, pricing.ts do).  
* Test-case totals (approx, it(/test( with string arg): domain \~179, infrastructure \~35, application \~12, gateway \~129.

### **Design-vs-doc drift (cite before trusting any status doc)**

* docs/roadmap/ROADMAP.md:39 — Phase 4 "**done** … HTTP wiring complete, 302 tests pass". Reality: 0 Phase-4 routes in tree.  
* docs/roadmap/phase-04-guest-checkout-tickets.md:133-204 — lists 30+ shipped routes \+ "Build PASS / Tests 302 / TypeCheck PASS / Boundaries PASS". None reproducible.  
* docs/PHASE\_5\_AUDIT\_REPORT.md — entirely stale (says all Phase-5 routes are 501).  
* docs/phase-05-implementation-plan.md and docs/PHASE\_5\_IMPLEMENTATION\_PLAN.md — both pre-date 5A/5B existing; PHASE\_5\_HTTP\_WIRING\_PLAN.md:3 explicitly marks the former "Supersedes … written as if 5A/5B didn't exist yet; they do".  
* docs/roadmap/phase-05-door-scanner-cover-wallet.md — has the file **duplicated inline** (lines 1-57 then 58-319 repeat with a different Status line — "substantially done" vs "not started").  
* Phase-5 Session Log (:271-274): a prior uncommitted ROADMAP.md edit claimed "done … 29/29 contract tests pass" which "was never actually true"; contract-suite.test.ts "test never actually ran before — '29/29' was aspirational".  
* route-manifest.ts:29-32 correctly documents the intended invariant: blocked slices (orders/checkout/payments/refunds/payouts/webhooks) "**must NOT be registered … they 404 by absence, never by a 501 stub**" — the codebase honors this (app.test.ts:26-30).

### **Other noted debt (from docs, not independently re-verified)**

* X-User-Id/X-Organization-Id headers honored on STORAGE\_DRIVER=memory only (v2-services.ts:119-148); looks like an auth bypass in isolation (WORK-REPORT-2026-08-14-sagar.md:192).  
* First super admin seeded out-of-band via pnpm \--filter api-gateway seed:admin (correct — no self-service path to platform authority).  
* Organization.platformFeePercent defaults to 15 for pre-existing Firestore docs (WORK-REPORT-2026-08-14-sagar.md:200).  
* Dream-Architecture patterns still absent (design target, not yet required by any live phase): external event queue/Kafka (only InProcessEventBus), Outbox DB adapter (only MemoryOutboxStore, v2-services.ts:164), CQRS write-side projections (consumer is no-op :170), Redis seat-locking, generic webhook framework, DLQ, OpenTelemetry/Prometheus observability (PHASE\_5\_AUDIT\_REPORT.md:28-42).

