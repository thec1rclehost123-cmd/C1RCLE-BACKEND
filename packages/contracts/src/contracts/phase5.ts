import { z } from 'zod';
import { opaqueIdSchema, paginatedSchema, idempotencyKeySchema } from './shared.js';

/**
 * ─── Phase 5: Door / Scanner / Cover Wallet Contracts ────────────────────────
 */

// Scanner Session
export const scannerSessionCreateBodySchema = z.object({
  eventId: opaqueIdSchema,
  code: z.string().min(1),
  deviceId: z.string().min(1),
  deviceName: z.string().min(1),
  sessionType: z.enum(['staff', 'device']),
}).strict();
export type ScannerSessionCreateBody = z.infer<typeof scannerSessionCreateBodySchema>;

export const scannerSessionDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  codeId: opaqueIdSchema,
  sessionToken: z.string().min(1),
  sessionExpiresAt: z.iso.datetime(),
  permissions: z.object({
    canScan: z.boolean(),
    canDoorEntry: z.boolean(),
    canWalkIn: z.boolean(),
    canCharge: z.boolean(),
  }),
  status: z.enum(['active', 'revoked', 'expired']),
  createdAt: z.iso.datetime(),
});
export type ScannerSessionDto = z.infer<typeof scannerSessionDtoSchema>;

// Scan Request/Response
export const scanRequestSchema = z.object({
  eventId: opaqueIdSchema,
  qrPayload: z.string().min(1),
  scannedBy: z.object({
    uid: opaqueIdSchema,
    name: z.string(),
    role: z.string(),
  }),
  gate: z.string().optional(),
  deviceId: z.string().optional(),
  isOffline: z.boolean().optional(),
}).strict();
export type ScanRequest = z.infer<typeof scanRequestSchema>;

export const scanResponseSchema = z.object({
  status: z.enum(['consumed', 'denied']),
  checkInId: opaqueIdSchema.optional(),
  denyReason: z.enum([
    'invalid_signature',
    'already_used',
    'expired',
    'wrong_event',
    'device_invalid',
    'void_ticket',
    'capacity_exceeded',
    'wrong_gate',
    'offline_expired',
    'override_required',
    'promoter_not_authorized',
  ]).optional(),
  denyMessage: z.string().optional(),
  entitlement: z.object({
    id: opaqueIdSchema,
    tierName: z.string(),
    holderName: z.string(),
    scansUsed: z.number().int(),
    scansAllowed: z.number().int(),
  }).optional(),
});
export type ScanResponse = z.infer<typeof scanResponseSchema>;

// Magic Ticket QR
export const magicQrRequestSchema = z.object({
  entitlementId: opaqueIdSchema,
  tierPricePaise: z.number().int().nonnegative(),
}).strict();
export type MagicQrRequest = z.infer<typeof magicQrRequestSchema>;

export const magicQrResponseSchema = z.object({
  qrPayload: z.string(), // HMAC(entitlementId:timestamp)
  expiresAt: z.iso.datetime(),
  refreshIntervalSec: z.number().int().default(30),
});
export type MagicQrResponse = z.infer<typeof magicQrResponseSchema>;

// Offline Support
export const offlineManifestRequestSchema = z.object({
  eventId: opaqueIdSchema,
  scannerSessionId: opaqueIdSchema,
  expiresAt: z.iso.datetime(),
}).strict();
export type OfflineManifestRequest = z.infer<typeof offlineManifestRequestSchema>;

export const offlineManifestResponseSchema = z.object({
  manifest: z.array(z.object({
    entitlementId: opaqueIdSchema,
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime(),
    signature: z.string(),
  })),
  signedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type OfflineManifestResponse = z.infer<typeof offlineManifestResponseSchema>;

export const offlineSyncRequestSchema = z.object({
  scannerSessionId: opaqueIdSchema,
  scans: z.array(z.object({
    payload: z.string(),
    scannedAt: z.iso.datetime(),
    deviceId: z.string(),
  })),
}).strict();
export type OfflineSyncRequest = z.infer<typeof offlineSyncRequestSchema>;

export const offlineSyncResponseSchema = z.object({
  synced: z.number().int(),
  conflicts: z.array(z.object({
    payload: z.string(),
    reason: z.string(),
  })),
});
export type OfflineSyncResponse = z.infer<typeof offlineSyncResponseSchema>;

// Door Schemas
export const doorWalkInRequestSchema = z.object({
  eventId: opaqueIdSchema,
  guestName: z.string().min(1),
  guestPhone: z.string().optional().nullable(),
  guestAge: z.number().int().min(0).max(120).optional().nullable(),
  gender: z.string().optional().nullable(),
  contact: z.string().optional().nullable(),
  totalGuests: z.number().int().min(1).max(100).default(1),
  gate: z.string().optional().nullable(),
  paymentMode: z.enum(['cash', 'card', 'upi', 'other']).default('cash'),
  tierId: opaqueIdSchema,
  quantity: z.number().int().min(1).max(100).default(1),
  idempotencyKey: idempotencyKeySchema,
}).strict();
export type DoorWalkInRequest = z.infer<typeof doorWalkInRequestSchema>;

export const doorDineInRequestSchema = doorWalkInRequestSchema.extend({
  tableNumber: z.string().optional().nullable(),
}).strict();
export type DoorDineInRequest = z.infer<typeof doorDineInRequestSchema>;

export const doorSaleResponseSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  category: z.enum(['walkin', 'dinein']),
  guestName: z.string(),
  totalGuests: z.number().int(),
  amountPaise: z.number().int().nonnegative(),
  paymentMode: z.enum(['cash', 'card', 'upi', 'other']),
  status: z.enum(['active', 'voided', 'refunded']),
  createdAt: z.iso.datetime(),
});
export type DoorSaleResponse = z.infer<typeof doorSaleResponseSchema>;

export const doorSalesListResponseSchema = paginatedSchema(doorSaleResponseSchema);
export type DoorSalesListResponse = z.infer<typeof doorSalesListResponseSchema>;

// Cover Wallet Schemas
export const coverWalletIssueRequestSchema = z.object({
  eventId: opaqueIdSchema,
  userId: opaqueIdSchema,
  openingBalancePaise: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type CoverWalletIssueRequest = z.infer<typeof coverWalletIssueRequestSchema>;

export const coverWalletDebitRequestSchema = z.object({
  walletId: opaqueIdSchema,
  amountPaise: z.number().int().positive(),
  referenceId: opaqueIdSchema.optional(),
  referenceType: z.string().optional(),
  description: z.string().optional(),
  idempotencyKey: idempotencyKeySchema,
  deviceId: z.string().optional(),
}).strict();
export type CoverWalletDebitRequest = z.infer<typeof coverWalletDebitRequestSchema>;

export const coverWalletCreditRequestSchema = z.object({
  walletId: opaqueIdSchema,
  amountPaise: z.number().int().positive(),
  referenceId: opaqueIdSchema.optional(),
  referenceType: z.string().optional(),
  description: z.string().optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict();
export type CoverWalletCreditRequest = z.infer<typeof coverWalletCreditRequestSchema>;

export const coverWalletResponseSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  userId: opaqueIdSchema,
  balancePaise: z.number().int().nonnegative(),
  status: z.enum(['active', 'terminated', 'closed']),
  openingBalancePaise: z.number().int().nonnegative(),
  totalCreditsPaise: z.number().int().nonnegative(),
  totalDebitsPaise: z.number().int().nonnegative(),
  terminatedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type CoverWalletResponse = z.infer<typeof coverWalletResponseSchema>;

export const coverWalletReconciliationRequestSchema = z.object({
  eventId: opaqueIdSchema,
  reconciliationDate: z.iso.date(),
  walletId: opaqueIdSchema.optional(),
  userId: opaqueIdSchema.optional(),
}).strict();
export type CoverWalletReconciliationRequest = z.infer<typeof coverWalletReconciliationRequestSchema>;

export const coverWalletReconciliationResponseSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  reconciliationDate: z.iso.date(),
  expectedBalancePaise: z.number().int(),
  actualBalancePaise: z.number().int(),
  discrepancyPaise: z.number().int(),
  status: z.enum(['pending', 'completed', 'discrepancy', 'resolved']),
  discrepancies: z.array(z.object({
    type: z.enum([
      'balance_mismatch',
      'missing_credit',
      'missing_debit',
      'extra_transaction',
      'duplicate_transaction',
      'offline_sync_gap',
    ]),
    walletId: opaqueIdSchema,
    expectedAmountPaise: z.number().int(),
    actualAmountPaise: z.number().int(),
    transactionId: opaqueIdSchema.nullable(),
    description: z.string(),
  })),
  createdAt: z.iso.datetime(),
});
export type CoverWalletReconciliationResponse = z.infer<typeof coverWalletReconciliationResponseSchema>;

// Phase 5 Error Codes
export const phase5ErrorCodeSchema = z.enum([
  'SCANNER_SESSION_EXPIRED',
  'VELOCITY_LIMIT_EXCEEDED',
  'WALLET_TERMINATED',
  'OFFLINE_MANIFEST_EXPIRED',
  'MAGIC_TICKET_SIGNATURE_INVALID',
  'SCANNER_SESSION_REVOKED',
  'COVER_WALLET_INSUFFICIENT_BALANCE',
  'DOOR_SALE_PRICE_MISMATCH',
]);
export type Phase5ErrorCode = z.infer<typeof phase5ErrorCodeSchema>;