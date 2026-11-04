/** Ticket units, preserving the existing per-person group inventory convention. */
export function tierLineUnits(line: {
  quantity: number;
  guestCount?: number;
  admissionMode?: string;
}): number {
  return line.quantity * (line.admissionMode === 'per_person' ? (line.guestCount ?? 1) : 1);
}

interface ClaimLine {
  tierId: string;
  quantity: number;
  guestCount?: number;
  admissionMode?: string;
  pricingPhaseId?: string | null;
}
interface OrderClaim {
  status: string;
  lines: ClaimLine[];
  refundedTicketClaims?: {
    entitlementId: string;
    tierId: string;
    pricingPhaseId?: string | null;
  }[];
}
interface HoldClaim {
  status: string;
  expiresAt: string;
  lines: ClaimLine[];
}

/** Sold and held obligations; never includes the event/venue's shared capacity. */
export function committedTierQuantity(
  tierId: string,
  orders: readonly OrderClaim[],
  holds: readonly HoldClaim[],
  now: Date,
  pricingPhaseId?: string,
): number {
  const matches = (line: ClaimLine) =>
    line.tierId === tierId &&
    (pricingPhaseId === undefined ||
      line.pricingPhaseId === undefined ||
      line.pricingPhaseId === pricingPhaseId);
  let quantity = 0;
  for (const order of orders) {
    if (order.status !== 'paid' && order.status !== 'refund_requested') continue;
    let committed = 0;
    for (const line of order.lines) if (matches(line)) committed += tierLineUnits(line);
    const released = new Set(
      (order.refundedTicketClaims ?? [])
        .filter((claim) => matches({ ...claim, quantity: 1 }))
        .map((claim) => claim.entitlementId),
    ).size;
    quantity += Math.max(0, committed - released);
  }
  for (const hold of holds) {
    if (hold.status !== 'active' || Date.parse(hold.expiresAt) <= now.getTime()) continue;
    for (const line of hold.lines) if (matches(line)) quantity += tierLineUnits(line);
  }
  return quantity;
}
