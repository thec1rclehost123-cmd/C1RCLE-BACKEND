import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createTicketTransfer } from './models/ticket-transfer.js';

const now = new Date('2026-11-04T12:00:00.000Z');
const recipientEmail = 'new-guest@example.test';
const input = {
  id: 'transfer-delivery',
  entitlementId: 'ticket',
  eventId: 'night',
  senderUserId: 'purchaser',
  recipientEmail,
  recipientEmailHash: createHash('sha256').update(recipientEmail).digest('hex'),
  now,
  expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
};
describe('private invitation delivery binding', () => {
  it('normalizes the private delivery address and requires its exact acceptance binding', () => {
    expect(
      createTicketTransfer({ ...input, recipientEmail: ' NEW-GUEST@EXAMPLE.TEST ' }),
    ).toMatchObject({ recipientEmail, recipientUserId: null });
    expect(() =>
      createTicketTransfer({ ...input, recipientEmail: 'another@example.test' }),
    ).toThrow('must match');
    expect(() => createTicketTransfer({ ...input, recipientEmail: 'not-an-email' })).toThrow(
      'must match',
    );
  });
});
