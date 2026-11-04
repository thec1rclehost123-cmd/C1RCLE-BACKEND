import { afterEach, describe, expect, it, vi } from 'vitest';

import { RazorpayPaymentProvider } from './razorpay-adapter.js';

const provider = new RazorpayPaymentProvider({
  keyId: 'rzp_test_synthetic',
  keySecret: 'synthetic',
  webhookSecret: 'synthetic',
});
const fact = {
  id: 'rfnd_1',
  payment_id: 'pay_1',
  amount: 1000,
  currency: 'INR',
  receipt: 'refund:request_1',
  status: 'processed',
};

afterEach(() => vi.unstubAllGlobals());

describe('Razorpay read-only refund recovery', () => {
  it('fetches a specific payment refund and maps its authoritative identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(fact));
    vi.stubGlobal('fetch', fetchMock);
    await expect(provider.getRefund('pay_1', 'rfnd_1')).resolves.toEqual({
      id: 'rfnd_1',
      paymentId: 'pay_1',
      amountPaise: 1000,
      currency: 'INR',
      receipt: 'refund:request_1',
      status: 'processed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.com/v1/payments/pay_1/refunds/rfnd_1');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it.each([
    { id: 'rfnd_other' },
    { payment_id: 'pay_other' },
    { amount: 0 },
    { amount: 1.5 },
    { amount: Number.MAX_SAFE_INTEGER + 1 },
    { status: 'unknown' },
    { currency: null },
    { receipt: undefined },
  ])('rejects invalid provider evidence: %j', async (patch) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...fact, ...patch })));
    await expect(provider.getRefund('pay_1', 'rfnd_1')).rejects.toThrow(
      'Invalid provider refund fact',
    );
  });

  it.each([404, 409, 429, 500, 503])(
    'does not infer refund failure from lookup HTTP %i',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));
      await expect(provider.getRefund('pay_1', 'rfnd_1')).rejects.toThrow(
        'Unable to establish provider refund fact',
      );
    },
  );

  it('rejects traversal without contacting the provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(provider.getRefund('pay_1', '../refunds')).rejects.toThrow(
      'Invalid Razorpay refund id',
    );
    await expect(provider.getRefund('../payments', 'rfnd_1')).rejects.toThrow(
      'Invalid Razorpay payment id',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
