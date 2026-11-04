import { describe, expect, it } from 'vitest';

import { reconcileRefundRequestSchema } from './contracts/phase6.js';

describe('refund reconciliation command', () => {
  const valid = { providerRefundId: 'rfnd_synthetic', reason: 'Review of missing refund response' };
  it('accepts only an id hint and a trimmed operator reason', () => {
    expect(reconcileRefundRequestSchema.parse({ ...valid, reason: '  reviewed  ' }).reason).toBe(
      'reviewed',
    );
  });
  it.each([
    {},
    { ...valid, reason: ' ' },
    { ...valid, providerRefundId: '../refunds' },
    { ...valid, status: 'processed' },
    { ...valid, amountPaise: 1 },
    { ...valid, receipt: 'forged' },
    { ...valid, reason: 'x'.repeat(2001) },
  ])('rejects invalid or operator-supplied facts: %j', (body) => {
    expect(reconcileRefundRequestSchema.safeParse(body).success).toBe(false);
  });
});
