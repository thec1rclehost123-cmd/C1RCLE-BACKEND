import { DefiniteProviderFailureError } from '@c1rcle/core/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RazorpayPaymentProvider } from './razorpay-adapter.js';

const provider = new RazorpayPaymentProvider({
  keyId: 'rzp_test_synthetic',
  keySecret: 'synthetic-secret',
  webhookSecret: 'synthetic-webhook-secret',
});
const request = { paymentId: 'pay_synthetic', amountPaise: 1000, idempotencyKey: 'refund-test' };
const rejection = { error: { code: 'BAD_REQUEST_ERROR', description: 'Invalid refund amount' } };

afterEach(() => vi.unstubAllGlobals());

describe('Razorpay refund error classification', () => {
  it.each([400, 401, 403, 404, 422])('recognizes structured rejection HTTP %i', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(rejection, { status })));
    await expect(provider.refundPayment(request)).rejects.toBeInstanceOf(
      DefiniteProviderFailureError,
    );
  });

  it.each([408, 409, 425, 429, 500, 502, 503, 504])(
    'never treats HTTP %i as definite, even with a rejection-shaped body',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(rejection, { status })));
      const error = await provider.refundPayment(request).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(DefiniteProviderFailureError);
    },
  );

  it.each([
    { error: null },
    {},
    { error: { description: 'unclassified response' } },
    { error: { code: 'SERVER_ERROR', description: 'Internal server error' } },
    { error: { code: 'UNKNOWN_ERROR', description: 'Unknown' } },
  ])('keeps unclassified HTTP 400 bodies uncertain: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status: 400 })));
    const error = await provider.refundPayment(request).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DefiniteProviderFailureError);
  });

  it.each([200, 400, 502])('keeps unreadable HTTP %i bodies uncertain', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not JSON', { status })));
    const error = await provider.refundPayment(request).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DefiniteProviderFailureError);
  });

  it.each([new TypeError('connection reset'), new DOMException('Timed out', 'TimeoutError')])(
    'preserves transport uncertainty: %s',
    async (failure) => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));
      await expect(provider.refundPayment(request)).rejects.toBe(failure);
    },
  );
});
