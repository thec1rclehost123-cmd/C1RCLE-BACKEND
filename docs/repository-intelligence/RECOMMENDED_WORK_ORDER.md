# Recommended Work Order

1. Freeze evidence: prove exact worktree identity, route/contract parity, and live/fixture/unavailable classification.
2. P1 authorization: deny-case tenant/role/session tests across UI/BFF/Gateway/Core.
3. P1 payment: Test Mode order/hold/capture/callback/webhook/recovery/fulfillment/refund/reconciliation matrix.
4. P1 persistence/operations: Firestore indexes/rules, email/outbox, deployment variables, rollback and smoke procedures.
5. P2 product completeness: connect or explicitly gate fixture-backed partner and guest surfaces.
6. P2/P3 quality: visual/accessibility, performance, mutation/property testing, cleanup and documentation sync.

Do not combine payment correctness with unrelated visual refactors. Do not treat deployment, production, or live-provider actions as implied by this audit.
