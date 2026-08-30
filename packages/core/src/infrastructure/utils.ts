/**
 * ─── Storage-driver factory (B12) ────────────────────────────────────────────
 * The single place the storage implementation is chosen. `buildRepositories`
 * returns the full `ServiceDeps['repositories']` bundle for the `memory` or
 * `firestore` driver; `buildActorContext` / `buildIdempotencyStore` /
 * `firestoreClient` are the small helpers the gateway wiring needs.
 *
 * No `process.env` here (credentials are injected via `StorageDriverConfig`),
 * no Fastify, no `firebase-admin` — the firestore client is reached only
 * through `./firestore/client.js`.
 */

import { UnauthorizedError } from '../domain/errors.js';

import { getFirestoreClient, getStorageClient } from './firestore/client.js';
import {
  FirestoreOrganizationRepository,
  FirestoreVenueRepository,
  FirestorePartnershipRepository,
  FirestoreReferralLinkRepository,
  FirestorePromoterConnectionRepository,
  FirestoreInvitationRepository,
  FirestoreSlotRequestRepository,
  FirestoreVenueSlotRepository,
  FirestoreEventRepository,
  FirestoreEventCatalogRepository,
  FirestoreAnalyticsReadModelRepository,
  FirestoreOnboardingRepository,
  FirestorePlatformAdminRepository,
  FirestoreProposedActionRepository,
  FirestoreVerificationAttemptRepository,
  FirestoreCartReservationRepository,
  FirestoreOrderRepository,
  FirestoreEntitlementRepository,
  FirestorePromoRedemptionRepository,
  FirestoreScanLedgerRepository,
  FirestoreEventCodeRepository,
  FirestoreScannerSessionRepository,
  FirestoreDoorSaleRepository,
  FirestoreCoverWalletRepository,
  FirestoreCoverWalletTxnRepository,
  FirestoreCoverWalletReconciliationRepository,
} from './firestore/index.js';
import {
  MemoryOrganizationRepository,
  MemoryPartnershipRepository,
  MemoryReferralLinkRepository,
  MemoryPromoterConnectionRepository,
  MemoryInvitationRepository,
  MemoryEventRepository,
  MemoryVenueRepository,
  MemorySlotRequestRepository,
  MemoryVenueSlotRepository,
  MemoryEventCatalogRepository,
  MemoryAnalyticsReadModelRepository,
  MemoryCartReservationRepository,
  MemoryOrderRepository,
  MemoryEntitlementRepository,
  MemoryPromoRedemptionRepository,
  MemoryOnboardingRepository,
  MemoryPlatformAdminRepository,
  MemoryProposedActionRepository,
  MemoryVerificationAttemptRepository,
  MemoryScanLedgerRepository,
  MemoryEventCodeRepository,
  MemoryScannerSessionRepository,
  MemoryDoorSaleRepository,
  MemoryCoverWalletRepository,
  MemoryCoverWalletTxnRepository,
  MemoryCoverWalletReconciliationRepository,
} from './memory/index.js';
import { MemoryIdempotencyStore } from './memory/memory-idempotency-store.js';

import type { ServiceDeps, ActorContext } from '../application/context.js';

/**
 * Storage-driver config this factory needs. A structural subset (not an
 * import of `apps/api-gateway`'s `GatewayConfig`) — `packages/core` must not
 * depend on an app-layer type.
 */
export interface StorageDriverConfig {
  STORAGE_DRIVER: 'memory' | 'firestore';
  FIRESTORE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
}

/**
 * Builds the complete repository set based on the storage driver.
 * This is the single place where the storage implementation is chosen.
 */
export function buildRepositories(gw: StorageDriverConfig): ServiceDeps['repositories'] {
  const isMemory = gw.STORAGE_DRIVER === 'memory';

  if (isMemory) {
    return {
      organizations: new MemoryOrganizationRepository(),
      invitations: new MemoryInvitationRepository(),
      partnerships: new MemoryPartnershipRepository(),
      referralLinks: new MemoryReferralLinkRepository(),
      promoterConnections: new MemoryPromoterConnectionRepository(),
      venues: new MemoryVenueRepository(),
      slotRequests: new MemorySlotRequestRepository(),
      venueSlots: new MemoryVenueSlotRepository(),
      events: new MemoryEventRepository(),
      catalog: new MemoryEventCatalogRepository(),
      analytics: new MemoryAnalyticsReadModelRepository(),
      onboarding: new MemoryOnboardingRepository(),
      platformAdmins: new MemoryPlatformAdminRepository(),
      proposals: new MemoryProposedActionRepository(),
      verificationAttempts: new MemoryVerificationAttemptRepository(),
      cartReservations: new MemoryCartReservationRepository(),
      orders: new MemoryOrderRepository(),
      entitlements: new MemoryEntitlementRepository(),
      promoRedemptions: new MemoryPromoRedemptionRepository(),
      // Phase 5 repositories
      scanLedger: new MemoryScanLedgerRepository(),
      eventCodes: new MemoryEventCodeRepository(),
      scannerSessions: new MemoryScannerSessionRepository(),
      doorSales: new MemoryDoorSaleRepository(),
      coverWallets: new MemoryCoverWalletRepository(),
      coverWalletTxns: new MemoryCoverWalletTxnRepository(),
      coverWalletReconciliations: new MemoryCoverWalletReconciliationRepository(),
    };
  }

  if (!gw.FIREBASE_CLIENT_EMAIL || !gw.FIREBASE_PRIVATE_KEY) {
    throw new Error(
      'STORAGE_DRIVER=firestore requires FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY',
    );
  }
  const db = getFirestoreClient({
    projectId: gw.FIRESTORE_PROJECT_ID,
    clientEmail: gw.FIREBASE_CLIENT_EMAIL,
    privateKey: gw.FIREBASE_PRIVATE_KEY,
  });

  return {
    organizations: new FirestoreOrganizationRepository(db),
    invitations: new FirestoreInvitationRepository(db),
    partnerships: new FirestorePartnershipRepository(db),
    referralLinks: new FirestoreReferralLinkRepository(db),
    promoterConnections: new FirestorePromoterConnectionRepository(db),
    venues: new FirestoreVenueRepository(db),
    slotRequests: new FirestoreSlotRequestRepository(db),
    venueSlots: new FirestoreVenueSlotRepository(db),
    events: new FirestoreEventRepository(db),
    catalog: new FirestoreEventCatalogRepository(db),
    analytics: new FirestoreAnalyticsReadModelRepository(db),
    onboarding: new FirestoreOnboardingRepository(db),
    platformAdmins: new FirestorePlatformAdminRepository(db),
    proposals: new FirestoreProposedActionRepository(db),
    verificationAttempts: new FirestoreVerificationAttemptRepository(db),
    cartReservations: new FirestoreCartReservationRepository(db),
    orders: new FirestoreOrderRepository(db),
    entitlements: new FirestoreEntitlementRepository(db),
    promoRedemptions: new FirestorePromoRedemptionRepository(db),
    // Phase 5 repositories
    scanLedger: new FirestoreScanLedgerRepository(db),
    eventCodes: new FirestoreEventCodeRepository(db),
    scannerSessions: new FirestoreScannerSessionRepository(db),
    doorSales: new FirestoreDoorSaleRepository(db),
    coverWallets: new FirestoreCoverWalletRepository(db),
    coverWalletTxns: new FirestoreCoverWalletTxnRepository(db),
    coverWalletReconciliations: new FirestoreCoverWalletReconciliationRepository(db),
  };
}

/**
 * Creates an in-memory idempotency store for testing.
 */
export function buildIdempotencyStore() {
  return new MemoryIdempotencyStore();
}

/**
 * Creates the actor context from a Fastify request.
 * This extracts the authenticated user and organization context from the request.
 *
 * Phase 1 (auth-foundation) fix: throws the typed UnauthorizedError (code
 * 'unauthorized') rather than a generic Error, so routes that call this
 * directly (onboarding, admin, door, cover-wallet, scanner) return 401 not a
 * generic 500 when there is no session on the firestore driver.
 */
export function buildActorContext(request: { actor?: ActorContext }): ActorContext {
  if (!request.actor) {
    throw new UnauthorizedError('No authenticated actor on request.');
  }
  return request.actor;
}

/**
 * Creates a Firestore client from gateway config.
 */
export function firestoreClient(gw: StorageDriverConfig) {
  return getFirestoreClient(firestoreCredentials(gw));
}

/** The Firebase Storage handle from the same app — for signed upload URLs. */
export function storageClient(gw: StorageDriverConfig) {
  return getStorageClient(firestoreCredentials(gw));
}

function firestoreCredentials(gw: StorageDriverConfig) {
  if (!gw.FIREBASE_CLIENT_EMAIL || !gw.FIREBASE_PRIVATE_KEY) {
    throw new Error(
      'STORAGE_DRIVER=firestore requires FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY',
    );
  }
  return {
    projectId: gw.FIRESTORE_PROJECT_ID,
    clientEmail: gw.FIREBASE_CLIENT_EMAIL,
    privateKey: gw.FIREBASE_PRIVATE_KEY,
  };
}

export { getFirestoreClient, getStorageClient } from './firestore/client.js';
