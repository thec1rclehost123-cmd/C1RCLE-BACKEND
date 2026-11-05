import { InvalidOperationError } from '../errors.js';

import type { LedgerEntry } from './ledger.js';
import type { Order } from './order.js';

/** Server-only original commercial allocation. All values are exact integer paise. */
export interface SaleAllocationSnapshot {
  version: 'sale-allocation-v1';
  grossPaise: number;
  platformPaise: number;
  hostPaise: number;
  venuePaise: number;
  promoterPaise: number;
  hostOrganizationId: string;
  venueOrganizationId: string;
  promoterOrganizationId: string | null;
  partnershipId: string | null;
  partnershipVersion: number | null;
  onboardingId: string | null;
  onboardingVersion: number | null;
  capturedAt: string;
}

export function validateSaleAllocation(
  snapshot: SaleAllocationSnapshot,
  gross: number,
  host: string,
): SaleAllocationSnapshot {
  const amounts = [
    snapshot.grossPaise,
    snapshot.platformPaise,
    snapshot.hostPaise,
    snapshot.venuePaise,
    snapshot.promoterPaise,
  ];
  if (
    snapshot.version !== 'sale-allocation-v1' ||
    snapshot.hostOrganizationId !== host ||
    !snapshot.venueOrganizationId ||
    snapshot.grossPaise !== gross ||
    amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0) ||
    snapshot.platformPaise + snapshot.hostPaise + snapshot.venuePaise + snapshot.promoterPaise !==
      gross ||
    (snapshot.promoterPaise > 0 && !snapshot.promoterOrganizationId)
  ) {
    throw new InvalidOperationError('Original sale allocation evidence is invalid');
  }
  return snapshot;
}

/** Only a complete, conserving immutable legacy ledger can supply missing history. */
export function allocationFromLedger(order: Order, entries: LedgerEntry[]): SaleAllocationSnapshot {
  const gross = order.discountedAdmissionSubtotalPaise ?? order.discountedSubtotalPaise;
  const one = (type: LedgerEntry['entryType']) => {
    const rows = entries.filter((row) => row.entryType === type);
    const [row] = rows;
    if (rows.length !== 1 || !row)
      throw new InvalidOperationError('Original sale allocation evidence is incomplete');
    if (row.orderId !== order.id || row.eventId !== order.eventId)
      throw new InvalidOperationError('Original sale ledger identity is invalid');
    return row;
  };
  const revenue = one('ticket_revenue');
  const platform = one('platform_fee');
  const host = one('host_payout');
  const venue = one('venue_share');
  const promoters = entries.filter((row) => row.entryType === 'promoter_commission');
  if (
    promoters.length > 1 ||
    (order.attribution && promoters.length !== 1 && order.attribution.promoterCommissionPaise > 0)
  )
    throw new InvalidOperationError('Original sale promoter evidence is incomplete');
  const promoter = promoters[0];
  if (
    revenue.amount !== gross ||
    revenue.organizationId !== order.organizationId ||
    platform.organizationId !== order.organizationId ||
    (promoter &&
      (promoter.orderId !== order.id ||
        promoter.eventId !== order.eventId ||
        promoter.organizationId !== order.attribution?.promoterId))
  )
    throw new InvalidOperationError('Original sale ledger identity is invalid');
  return validateSaleAllocation(
    {
      version: 'sale-allocation-v1',
      grossPaise: gross,
      platformPaise: platform.amount,
      hostPaise: host.amount,
      venuePaise: venue.amount,
      promoterPaise: promoter?.amount ?? 0,
      hostOrganizationId: host.organizationId,
      venueOrganizationId: venue.organizationId,
      promoterOrganizationId: promoter?.organizationId ?? order.attribution?.promoterId ?? null,
      partnershipId: null,
      partnershipVersion: null,
      onboardingId: null,
      onboardingVersion: null,
      capturedAt: revenue.createdAt,
    },
    gross,
    order.organizationId,
  );
}
