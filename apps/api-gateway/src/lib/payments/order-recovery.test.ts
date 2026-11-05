import { afterEach, describe, expect, it, vi } from 'vitest';

import { RazorpayPaymentProvider } from './razorpay-adapter.js';
import { UnconfiguredPaymentProvider } from './unconfigured-provider.js';

const provider = new RazorpayPaymentProvider({
  keyId: 'rzp_test_synthetic',
  keySecret: 'synthetic',
  webhookSecret: 'synthetic',
  requestTimeoutMs: 20,
});
const receipt = 'c1_stable';
const fact = {
  id: 'order_synthetic',
  amount: 1000,
  currency: 'INR',
  status: 'created',
  receipt,
  notes: { holdId: 'HOLD-local', eventId: 'EVT-local', organizationId: 'ORG-local' },
};
afterEach(() => vi.unstubAllGlobals());

describe('Razorpay bounded read-only order recovery', () => {
  it('uses the documented receipt filter, retains identity, and requests enough results to detect ambiguity', async () => {
    const network = vi.fn().mockResolvedValue(Response.json({ count: 1, items: [fact] }));
    vi.stubGlobal('fetch', network);
    await expect(provider.findOrdersByReceipt(receipt)).resolves.toEqual([
      {
        id: fact.id,
        amountPaise: 1000,
        currency: 'INR',
        status: 'created',
        receipt,
        metadata: fact.notes,
      },
    ]);
    const [url, init] = network.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.com/v1/orders?receipt=c1_stable&count=2');
    expect(init.method).toBe('GET');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('returns both matches so the application rejects ambiguous provider results', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ count: 2, items: [fact, { ...fact, id: 'order_other' }] }),
        ),
    );
    expect(await provider.findOrdersByReceipt(receipt)).toHaveLength(2);
  });
  it.each([
    { count: 1, items: [{ ...fact, receipt: 'other' }] },
    { count: 1, items: [{ ...fact, notes: [] }] },
    { count: 1, items: [{ ...fact, notes: { holdId: 123 } }] },
    { count: 2, items: [fact] },
    { items: [fact] },
  ])('rejects malformed or wrong-receipt provider facts %#', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
    await expect(provider.findOrdersByReceipt(receipt)).rejects.toThrow();
  });
  it('fails closed on an unavailable lookup without a POST', async () => {
    const network = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', network);
    await expect(provider.findOrdersByReceipt(receipt)).rejects.toThrow(/unavailable/);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('bounds an unresolved create request and does not retry it', async () => {
    const network = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new Error('Provider request timeout')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', network);
    await expect(
      provider.createOrder({
        amountPaise: 1000,
        currency: 'INR',
        idempotencyKey: receipt,
        metadata: fact.notes,
      }),
    ).rejects.toThrow(/aborted|timeout/i);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('keeps an unconfigured provider unavailable for recovery', async () => {
    await expect(new UnconfiguredPaymentProvider().findOrdersByReceipt(receipt)).rejects.toThrow(
      /not configured/,
    );
  });
});
