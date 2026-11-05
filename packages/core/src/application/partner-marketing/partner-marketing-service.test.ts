import { beforeEach, expect, it, vi } from 'vitest';

import { PartnerMarketingService } from './partner-marketing-service.js';

import type { ServiceDeps, ActorContext } from '../context.js';

const actor: ActorContext = {
  userId: 'partner',
  organizationId: 'org-a',
  role: 'owner',
  capabilities: ['host'],
};
let tickets: Record<string, unknown>[];
let orders: Record<string, unknown>[];
let service: PartnerMarketingService;
let transferStatus = 'pending';
const ticket = (extra: Record<string, unknown> = {}) => ({
  id: 'ticket',
  orderId: 'order-a',
  createdAt: '2026-11-02T10:00:00Z',
  organizationId: 'org-a',
  eventId: 'event-a',
  tierId: 'tier-a',
  tierName: 'VIP',
  userId: 'buyer',
  currentHolderUserId: 'buyer',
  holderName: 'Buyer',
  status: 'valid',
  ...extra,
});
beforeEach(() => {
  tickets = [ticket()];
  orders = [
    {
      id: 'order-a',
      organizationId: 'org-a',
      eventId: 'event-a',
      userId: 'buyer',
      status: 'paid',
      grandTotalPaise: 12000,
      refundedPaise: 2000,
      contact: { name: 'Buyer', email: 'private@example.invalid', phone: '+919000000000' },
    },
  ];
  transferStatus = 'pending';
  const page = (items: unknown[]) => ({ items, nextCursor: null });
  service = new PartnerMarketingService({
    events: {
      listByOrganization: vi.fn(async () =>
        page([{ id: 'event-a', organizationId: 'org-a', title: 'Night', status: 'published' }]),
      ),
    },
    orders: { listByOrganization: vi.fn(async () => page(orders)) },
    entitlements: {
      listByOrganization: vi.fn(async () => page(tickets)),
      getTicketTransfer: vi.fn(async () => ({ status: transferStatus })),
    },
    catalog: { listTiers: vi.fn(async () => [{ id: 'tier-a', name: 'VIP' }]) },
  } as unknown as ServiceDeps['repositories']);
});
it('groups ticket units by holder/event and deducts settled refunds from own spend only', async () => {
  tickets.push(
    ticket({ id: 't2', scanCountAllowed: 2 }),
    ticket({
      id: 'free',
      currentHolderUserId: 'recipient',
      holderName: 'Recipient',
      unitKind: 'free_rsvp',
    }),
  );
  const result = await service.list('org-a', actor, {});
  expect(
    result.rows.map(({ name, tickets, totalSpendPaise }) => ({ name, tickets, totalSpendPaise })),
  ).toEqual([
    { name: 'Buyer', tickets: 2, totalSpendPaise: 10000 },
    { name: 'Recipient', tickets: 1, totalSpendPaise: 0 },
  ]);
  expect(JSON.stringify(result)).not.toContain('buyer');
  expect(JSON.stringify(result)).not.toContain('private@example.invalid');
  expect(JSON.stringify(result)).not.toContain('+919000000000');
  expect(Object.keys(result.rows[0] ?? {})).toEqual([
    'id',
    'name',
    'eventId',
    'eventName',
    'tickets',
    'totalSpendPaise',
  ]);
});
it('moves attendance after accepted transfer without moving purchaser spend', async () => {
  tickets = [ticket({ currentHolderUserId: 'recipient', holderName: 'Recipient' })];
  expect((await service.list('org-a', actor, {})).rows[0]).toMatchObject({
    name: 'Recipient',
    totalSpendPaise: 0,
  });
});
it('excludes unclaimed, void, refund locked, frozen and cross-tenant units', async () => {
  tickets = [
    ticket({ currentHolderUserId: null }),
    ticket({ status: 'void' }),
    ticket({ refundLock: {} }),
    ticket({ pendingTransferId: 'transfer' }),
    ticket({ organizationId: 'org-b' }),
  ];
  transferStatus = 'frozen';
  expect((await service.list('org-a', actor, {})).rows).toEqual([]);
});
it('retains pending transfer sender and legacy purchaser fallback', async () => {
  tickets = [ticket({ pendingTransferId: 'transfer', currentHolderUserId: undefined })];
  expect((await service.list('org-a', actor, {})).rows).toHaveLength(1);
});
it('filters only names and canonical event/tier ids', async () => {
  expect((await service.list('org-a', actor, { search: 'BUY' })).rows).toHaveLength(1);
  for (const query of [{ search: 'example.invalid' }, { eventId: 'event-b' }, { tierId: 'tier-b' }])
    expect((await service.list('org-a', actor, query)).rows).toEqual([]);
});
it('denies cross tenant, member and promoter access', async () => {
  await expect(service.list('org-b', actor, {})).rejects.toThrow('Cross-tenant');
  await expect(service.list('org-a', { ...actor, role: 'member' }, {})).rejects.toThrow('audience');
  await expect(service.list('org-a', { ...actor, capabilities: ['promoter'] }, {})).rejects.toThrow(
    'audience',
  );
});

it('counts actual issued units, including per-person groups, without inventing direct attribution', async () => {
  orders = [
    {
      id: 'order-a',
      organizationId: 'org-a',
      eventId: 'event-a',
      status: 'refunded',
      paidAt: '2026-11-01T10:00:00Z',
      attribution: { promoterId: 'promoter-a' },
      lines: [
        {
          tierId: 'tier-a',
          tierName: 'VIP',
          quantity: 1,
          guestCount: 2,
          admissionMode: 'per_person',
        },
      ],
    },
    {
      id: 'pending',
      organizationId: 'org-a',
      eventId: 'event-a',
      status: 'pending',
      paidAt: '2026-11-01T10:00:00Z',
      lines: [],
    },
  ];
  tickets = [
    ticket({ status: 'void' }),
    ticket({ id: 'ticket-b', currentHolderUserId: 'recipient' }),
    ticket({ id: 'pending-ticket', orderId: 'pending' }),
  ];
  const result = await service.tierPerformance('org-a', actor, '2026-11-02', '2026-11-03');
  expect(result.rows).toEqual([
    { eventId: 'event-a', eventName: 'Night', tierId: 'tier-a', name: 'VIP', tickets: 2 },
  ]);
  expect(result.channels).toEqual({ promoter: 2, unattributed: 0 });
  expect(result.purchaseDays).toEqual([0, 0, 0, 0, 0, 0, 0]);
  const captureDay = await service.tierPerformance('org-a', actor, '2026-11-01', '2026-11-01');
  expect(captureDay.rows).toEqual([]);
  expect(captureDay.purchaseDays).toEqual([1, 0, 0, 0, 0, 0, 0]);
});
