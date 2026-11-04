import { describe, expect, it } from 'vitest';

import { createTicketAccessCode } from '../../domain/models/ticket-access.js';

import { MemoryTicketAccessRepository } from './memory-ticket-access-repository.js';

const NOW = new Date('2026-10-28T12:00:00.000Z');

describe('MemoryTicketAccessRepository', () => {
  it('retries the same user idempotently and enforces the shared redemption ceiling', async () => {
    const repository = new MemoryTicketAccessRepository();
    const code = createTicketAccessCode({
      id: 'sha256-verifier',
      eventId: 'event_1',
      organizationId: 'org_1',
      tierIds: ['tier_1'],
      createdBy: 'host_1',
      startsAt: '2026-10-28T11:00:00.000Z',
      expiresAt: '2026-10-29T12:00:00.000Z',
      maxRedemptions: 1,
      now: NOW,
    });
    await repository.createCode(code);

    const first = await repository.redeem({
      codeId: code.id,
      grantId: 'grant-user-1',
      userId: 'guest_1',
      now: NOW,
    });
    const retry = await repository.redeem({
      codeId: code.id,
      grantId: 'grant-user-1',
      userId: 'guest_1',
      now: NOW,
    });
    const otherUser = await repository.redeem({
      codeId: code.id,
      grantId: 'grant-user-2',
      userId: 'guest_2',
      now: NOW,
    });

    expect(first?.grant.id).toBe('grant-user-1');
    expect(retry).toEqual(first);
    expect(otherUser).toBeNull();
    await expect(repository.getCodeById(code.id)).resolves.toMatchObject({ redemptionCount: 1 });
  });
});
