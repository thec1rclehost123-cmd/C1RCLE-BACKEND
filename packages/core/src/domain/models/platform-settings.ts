/**
 * ─── Platform-wide settings (admin-owned, singleton doc) ─────────────────────
 *
 * Replaces the hardcoded refund thresholds and provides a single source of
 * truth for platform governance knobs. The Firestore document is
 * `v2_platform_settings` (singleton — no collection, just one doc).
 *
 * Threshold changes take effect immediately on the next refund request;
 * no migration or restart required.
 */

export interface PlatformSettings {
  /** Default platform fee rate (decimal, e.g. 0.15 = 15%). */
  platformFeeRate: number;
  /** Refund threshold below which zero approvers are required (paise, default ₹500 = 50_000). */
  refundSingleApproverThresholdPaise: number;
  /** Refund threshold requiring two approvers at or above (paise, default ₹5_000 = 500_000). */
  refundDualApproverThresholdPaise: number;
  /** When true, the platform enters maintenance mode (ops-middleware gate). */
  maintenanceMode: boolean;
  /** Arbitrary feature flags for gradual rollouts. */
  featureFlags: Record<string, boolean>;
  updatedAt: string;
}

export interface PlatformSettingsInput {
  platformFeeRate?: number;
  refundSingleApproverThresholdPaise?: number;
  refundDualApproverThresholdPaise?: number;
  maintenanceMode?: boolean;
  featureFlags?: Record<string, boolean>;
}

/** Firestore document key for the singleton settings doc. */
export const PLATFORM_SETTINGS_DOC_ID = 'singleton';

/** Default thresholds matching v1's exact values. */
const DEFAULT_SINGLE_THRESHOLD = 50_000; // ₹500
const DEFAULT_DUAL_THRESHOLD = 500_000; // ₹5,000

export const DEFAULT_PLATFORM_SETTINGS: Readonly<PlatformSettings> = {
  platformFeeRate: 0.15,
  refundSingleApproverThresholdPaise: DEFAULT_SINGLE_THRESHOLD,
  refundDualApproverThresholdPaise: DEFAULT_DUAL_THRESHOLD,
  maintenanceMode: false,
  featureFlags: {},
  updatedAt: new Date(0).toISOString(),
};
