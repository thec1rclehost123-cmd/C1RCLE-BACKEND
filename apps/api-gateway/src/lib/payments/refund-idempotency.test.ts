import { afterEach, describe, expect, it, vi } from 'vitest';

import { RazorpayPaymentProvider } from './razorpay-adapter.js';

const provider = new RazorpayPaymentProvider({
  keyId: 'rzp_test_synthetic',
  keySecret: 'synthetic',
  webhookSecret: 'synthetic',
});
afterEach(() => vi.unstubAllGlobals());

describe('Razorpay canonical refund idempotency', () => {
  it('sends a stable provider-safe key while preserving the canonical receipt', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ id: 'rfnd_fixture', amount: 1000, status: 'processed' })),
      );
    vi.stubGlobal('fetch', fetchMock);
    const request = {
      paymentId: 'pay_fixture',
      amountPaise: 1000,
      idempotencyKey: 'refund:canonical-request',
    };
    await provider.refundPayment(request);
    await provider.refundPayment(request);
    const first = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const key = new Headers(first.headers).get('X-Refund-Idempotency');
    expect(key).toMatch(/^[A-Za-z0-9_-]{10,}$/);
    expect(new Headers(second.headers).get('X-Refund-Idempotency')).toBe(key);
    expect(JSON.parse(first.body as string)).toEqual({
      amount: 1000,
      receipt: request.idempotencyKey,
    });
    expect(second.body).toBe(first.body);
  });

  it('rejects an empty canonical key before sending a refund', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      provider.refundPayment({ paymentId: 'pay_fixture', amountPaise: 1000, idempotencyKey: '' }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
