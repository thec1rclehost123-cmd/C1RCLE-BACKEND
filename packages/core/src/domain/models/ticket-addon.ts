import { createHash } from 'node:crypto';

import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/** Non-cover event products that are issued to an existing admission entitlement. */
export const TICKET_ADDON_KINDS = ['parking', 'cloakroom', 'merchandise'] as const;
export type TicketAddonKind = (typeof TICKET_ADDON_KINDS)[number];
export type TicketAddonStatus = 'active' | 'paused';

/** Immutable add-on price/identity captured in quote, hold and paid order. */
export interface TicketAddonSelection {
  addonId: EntityId;
  name: string;
  kind: TicketAddonKind;
  unitPricePaise: number;
  quantityPerEntitlement: number;
}

/** Add-on right attached to one admission entitlement; no door credential is minted. */
export interface TicketAddonEntitlement {
  id: EntityId;
  addonId: EntityId;
  name: string;
  kind: TicketAddonKind;
  unitPricePaise: number;
  status: 'active' | 'redeemed' | 'void';
  createdAt: string;
  redeemedAt: string | null;
}

export function ticketAddonEntitlementId(
  orderId: EntityId,
  entitlementId: EntityId,
  addonId: EntityId,
  unitIndex: number,
): EntityId {
  const digest = createHash('sha256')
    .update(`${orderId}:${entitlementId}:${addonId}:${unitIndex}`)
    .digest('hex');
  return `TAE-${digest.slice(0, 32)}`;
}

export function issueTicketAddonEntitlements(input: {
  orderId: EntityId;
  entitlementId: EntityId;
  selections: TicketAddonSelection[];
  now: Date;
}): TicketAddonEntitlement[] {
  return input.selections.flatMap((selection) =>
    Array.from({ length: selection.quantityPerEntitlement }, (_, unitIndex) => ({
      id: ticketAddonEntitlementId(
        input.orderId,
        input.entitlementId,
        selection.addonId,
        unitIndex,
      ),
      addonId: selection.addonId,
      name: selection.name,
      kind: selection.kind,
      unitPricePaise: selection.unitPricePaise,
      status: 'active' as const,
      createdAt: input.now.toISOString(),
      redeemedAt: null,
    })),
  );
}

export interface TicketAddon extends VersionedEntity {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  name: string;
  description: string;
  kind: TicketAddonKind;
  currency: 'INR';
  /** Non-cover amount, in paise, per add-on unit. */
  priceInPaise: number;
  /** Total saleable units. Sold and held units are counted separately. */
  quantity: number;
  /** Maximum units one admission entitlement may own. */
  maxPerEntitlement: number;
  salesStartAt: string | null;
  salesEndAt: string | null;
  status: TicketAddonStatus;
}

export interface CreateTicketAddonInput {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  name: string;
  description?: string;
  kind: TicketAddonKind;
  priceInPaise: number;
  quantity: number;
  maxPerEntitlement?: number;
  salesStartAt?: string | null;
  salesEndAt?: string | null;
  status?: TicketAddonStatus;
  now?: Date;
}

export function createTicketAddon(input: CreateTicketAddonInput): TicketAddon {
  const name = input.name.trim();
  const description = input.description?.trim() ?? '';
  const maxPerEntitlement = input.maxPerEntitlement ?? 1;
  const salesStartAt = input.salesStartAt ?? null;
  const salesEndAt = input.salesEndAt ?? null;

  if (!name || name.length > 120) throw new InvalidOperationError('Add-on name is invalid');
  if (description.length > 1000) throw new InvalidOperationError('Add-on description is too long');
  if (!TICKET_ADDON_KINDS.includes(input.kind))
    throw new InvalidOperationError('Unsupported ticket add-on kind');
  if (!Number.isSafeInteger(input.priceInPaise) || input.priceInPaise <= 0)
    throw new InvalidOperationError('Add-on price must be a positive whole number of paise');
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 0)
    throw new InvalidOperationError('Add-on quantity must be a non-negative whole number');
  if (!Number.isSafeInteger(maxPerEntitlement) || maxPerEntitlement < 1 || maxPerEntitlement > 10)
    throw new InvalidOperationError('Add-on limit per ticket must be between 1 and 10');
  if (
    (salesStartAt !== null && !Number.isFinite(Date.parse(salesStartAt))) ||
    (salesEndAt !== null && !Number.isFinite(Date.parse(salesEndAt)))
  ) {
    throw new InvalidOperationError('Add-on sale dates must be valid ISO timestamps');
  }
  if (salesStartAt && salesEndAt && Date.parse(salesEndAt) <= Date.parse(salesStartAt)) {
    throw new InvalidOperationError('Add-on sales must end after they start');
  }

  const now = input.now ?? new Date();
  return {
    id: input.id,
    eventId: input.eventId,
    organizationId: input.organizationId,
    name,
    description,
    kind: input.kind,
    currency: 'INR',
    priceInPaise: input.priceInPaise,
    quantity: input.quantity,
    maxPerEntitlement,
    salesStartAt,
    salesEndAt,
    status: input.status ?? 'active',
    ...newVersionedEntity(now),
  };
}

export function updateTicketAddon(
  addon: TicketAddon,
  changes: Partial<
    Pick<
      TicketAddon,
      | 'name'
      | 'description'
      | 'priceInPaise'
      | 'quantity'
      | 'maxPerEntitlement'
      | 'salesStartAt'
      | 'salesEndAt'
      | 'status'
    >
  >,
  now = new Date(),
): TicketAddon {
  const updated = createTicketAddon({
    id: addon.id,
    eventId: addon.eventId,
    organizationId: addon.organizationId,
    name: changes.name ?? addon.name,
    description: changes.description ?? addon.description,
    kind: addon.kind,
    priceInPaise: changes.priceInPaise ?? addon.priceInPaise,
    quantity: changes.quantity ?? addon.quantity,
    maxPerEntitlement: changes.maxPerEntitlement ?? addon.maxPerEntitlement,
    salesStartAt: changes.salesStartAt === undefined ? addon.salesStartAt : changes.salesStartAt,
    salesEndAt: changes.salesEndAt === undefined ? addon.salesEndAt : changes.salesEndAt,
    status: changes.status ?? addon.status,
    now,
  });
  const versioned = bumpVersion(addon, now);
  return {
    ...updated,
    version: versioned.version,
    createdAt: versioned.createdAt,
    updatedAt: versioned.updatedAt,
  };
}
