/**
 * ─── In-memory adapter barrel ────────────────────────────────────────────────
 * Re-exports every `Memory*Repository` / `Memory*Store` implementation so
 * `infrastructure/utils.ts`'s `buildRepositories` can pull the whole set from
 * one path. Mirrors `firestore/index.ts`.
 *
 * `MemoryCoverWalletReconciliationRepository` is sourced from
 * `memory-cover-wallet-repository.ts` (which also holds the wallet + txn
 * repos); the standalone `memory-cover-wallet-reconciliation-repository.ts`
 * carries a duplicate of that class and is intentionally NOT re-exported here.
 */

export * from './memory-idempotency-store.js';
export * from './memory-outbox-store.js';
export * from './memory-audit-repository.js';
export * from './memory-invitation-repository.js';
export * from './memory-partnership-repository.js';
export * from './memory-referral-link-repository.js';
export * from './memory-promoter-connection-repository.js';
export * from './memory-repositories.js';
export * from './memory-user-account-repository.js';
export * from './memory-onboarding-repository.js';
export * from './memory-scan-ledger-repository.js';
export * from './memory-event-code-repository.js';
export * from './memory-door-sale-repository.js';
export * from './memory-cover-wallet-repository.js';
export * from './memory-ledger-repository.js';
export * from './memory-payout-repository.js';
export * from './memory-bank-account-repository.js';
export * from './memory-dispute-repository.js';
export * from './memory-refund-request-repository.js';
export * from './memory-leaderboard-repository.js';
export * from './memory-email-otp-repository.js';
