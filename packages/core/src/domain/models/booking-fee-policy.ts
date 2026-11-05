import { InvalidOperationError } from '../errors.js';

/** Server-owned commercial terms. These rates are authorized for tests only. */
export interface BookingFeePolicy {
  readonly version: string;
  readonly label: string;
  readonly payer: 'guest';
  readonly environment: 'test';
  readonly platformFeeBasisPoints: number;
  readonly paymentFeeBasisPoints: number;
  readonly feeTaxBasisPoints: number;
  readonly guestRefund: 'admission_only';
  readonly organizerRefund: 'full_paid';
}

export const NON_PRODUCTION_BOOKING_FEE_POLICY: BookingFeePolicy = Object.freeze({
  version: 'm4-nonproduction-test-v1',
  label: 'Non-production test fees — not approved production commercial rates',
  payer: 'guest',
  environment: 'test',
  platformFeeBasisPoints: 500,
  paymentFeeBasisPoints: 250,
  feeTaxBasisPoints: 1800,
  guestRefund: 'admission_only',
  organizerRefund: 'full_paid',
});

export function snapshotBookingFeePolicy(policy: BookingFeePolicy): BookingFeePolicy {
  if (
    !policy.version?.trim() ||
    policy.version.length > 80 ||
    !policy.label?.trim() ||
    policy.label.length > 240 ||
    policy.payer !== 'guest' ||
    policy.environment !== 'test' ||
    policy.guestRefund !== 'admission_only' ||
    policy.organizerRefund !== 'full_paid' ||
    [policy.platformFeeBasisPoints, policy.paymentFeeBasisPoints, policy.feeTaxBasisPoints].some(
      (rate) => !Number.isSafeInteger(rate) || rate < 0 || rate > 10000,
    )
  )
    throw new InvalidOperationError('Invalid server booking fee policy');
  return Object.freeze({
    version: policy.version,
    label: policy.label,
    payer: policy.payer,
    environment: policy.environment,
    platformFeeBasisPoints: policy.platformFeeBasisPoints,
    paymentFeeBasisPoints: policy.paymentFeeBasisPoints,
    feeTaxBasisPoints: policy.feeTaxBasisPoints,
    guestRefund: policy.guestRefund,
    organizerRefund: policy.organizerRefund,
  });
}

/** Half-up integer rounding without unsafe intermediate floating-point money. */
export function feeAtBasisPoints(amountPaise: number, basisPoints: number): number {
  if (
    !Number.isSafeInteger(amountPaise) ||
    amountPaise < 0 ||
    !Number.isSafeInteger(basisPoints) ||
    basisPoints < 0 ||
    basisPoints > 10000
  ) {
    throw new InvalidOperationError('Invalid amount or fee rate');
  }
  const result = (BigInt(amountPaise) * BigInt(basisPoints) + 5000n) / 10000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new InvalidOperationError('Fee exceeds supported monetary range');
  return Number(result);
}
