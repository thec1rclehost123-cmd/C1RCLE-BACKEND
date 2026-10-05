import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RazorpayPaymentProvider } from './razorpay-adapter.js';

const CONFIG = {
  keyId: 'rzp_test_key',
  keySecret: 'rzp_test_secret',
  webhookSecret: 'webhook_secret',
  baseUrl: 'https://razorpay.test/v1',
};

const provider = () => new RazorpayPaymentProvider(CONFIG);

function jsonResponse(payload: unknown, ok = true, status = 200, statusText = 'OK') {
  return { ok, status, statusText, json: async () => payload } as unknown as Response;
}

function jsonError(payload: unknown) {
  return {
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    json: async () => payload,
  } as unknown as Response;
}

function brokenJson(statusText = 'Oops') {
  return {
    ok: false,
    status: 500,
    statusText,
    json: async () => {
      throw new Error('not json');
    },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RazorpayPaymentProvider — signature primitives', () => {
  it('generates the canonical HMAC-SHA256 signature (sorted keys, key=value&…)', () => {
    const signature = provider().generateSignature({ paymentId: 'pay_1', orderId: 'ord_1' });
    const expected = createHmac('sha256', CONFIG.webhookSecret)
      .update('orderId=ord_1&paymentId=pay_1')
      .digest('hex');
    expect(signature).toBe(expected);
  });

  it('verifies a matching webhook HMAC', () => {
    const body = '{"event":"payment.captured"}';
    const signature = createHmac('sha256', CONFIG.webhookSecret).update(body).digest('hex');
    expect(provider().verifyWebhookSignature(body, signature)).toBe(true);
  });

  it('rejects a tampered webhook HMAC', () => {
    const signature = createHmac('sha256', CONFIG.webhookSecret)
      .update('{"event":"payment.failed"}')
      .digest('hex');
    expect(provider().verifyWebhookSignature('{"event":"payment.captured"}', signature)).toBe(
      false,
    );
  });
});

describe('RazorpayPaymentProvider — createOrder', () => {
  it('posts the order and maps a valid response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ id: 'order_1', amount: 50000, currency: 'INR', status: 'created' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().createOrder({
      amountPaise: 50000,
      currency: 'INR',
      idempotencyKey: 'idem-1',
      metadata: { eventId: 'evt_1' },
    });

    expect(result).toEqual({
      id: 'order_1',
      amountPaise: 50000,
      currency: 'INR',
      status: 'created',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://razorpay.test/v1/orders');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toMatchObject({
      amount: 50000,
      currency: 'INR',
      receipt: 'idem-1',
      notes: { eventId: 'evt_1' },
    });
  });

  it('throws the error description when the provider returns an error payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonError({ error: { description: 'Insufficient balance' } })),
    );
    await expect(
      provider().createOrder({
        amountPaise: 100,
        currency: 'INR',
        idempotencyKey: 'idem-2',
        metadata: {},
      }),
    ).rejects.toThrow('Insufficient balance');
  });

  it('falls back to the status text when the error payload has no description', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonError({ error: { code: 'BANKING_ERROR' } })),
    );
    await expect(
      provider().createOrder({
        amountPaise: 100,
        currency: 'INR',
        idempotencyKey: 'idem-3',
        metadata: {},
      }),
    ).rejects.toThrow('Razorpay create order failed: Bad Request');
  });

  it('falls back to Unknown error when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(brokenJson()));
    await expect(
      provider().createOrder({
        amountPaise: 100,
        currency: 'INR',
        idempotencyKey: 'idem-4',
        metadata: {},
      }),
    ).rejects.toThrow('Unknown error');
  });

  it('throws when the order payload does not match the expected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'order_1' })));
    await expect(
      provider().createOrder({
        amountPaise: 100,
        currency: 'INR',
        idempotencyKey: 'idem-5',
        metadata: {},
      }),
    ).rejects.toThrow('Invalid Razorpay order response');
  });
});

describe('RazorpayPaymentProvider — verifyPayment', () => {
  it('rejects a signature mismatch', async () => {
    const signature = createHmac('sha256', 'wrong_secret')
      .update('orderId=ord_1&paymentId=pay_1')
      .digest('hex');
    await expect(
      provider().verifyPayment({ paymentId: 'pay_1', orderId: 'ord_1', signature }),
    ).rejects.toThrow('Invalid payment signature');
  });

  it('verifies a valid signature and returns the fetched payment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'pay_1',
          amount: 1000,
          currency: 'INR',
          status: 'captured',
          captured: true,
        }),
      ),
    );
    const signature = provider().generateSignature({ paymentId: 'pay_1', orderId: 'ord_1' });
    const result = await provider().verifyPayment({
      paymentId: 'pay_1',
      orderId: 'ord_1',
      signature,
    });
    expect(result).toMatchObject({ verified: true, paymentId: 'pay_1', captured: true });
  });

  it('throws when the signed payment cannot be found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonError({ error: { description: 'Payment not found' } })),
    );
    const signature = provider().generateSignature({ paymentId: 'pay_missing', orderId: 'ord_1' });
    await expect(
      provider().verifyPayment({ paymentId: 'pay_missing', orderId: 'ord_1', signature }),
    ).rejects.toThrow('Payment not found');
  });
});

describe('RazorpayPaymentProvider — capturePayment', () => {
  it('captures with an explicit amount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'pay_1',
          amount: 1000,
          currency: 'INR',
          status: 'captured',
          captured: true,
        }),
      ),
    );
    const result = await provider().capturePayment('pay_1', 1000);
    expect(result).toMatchObject({
      verified: true,
      paymentId: 'pay_1',
      amountPaise: 1000,
      captured: true,
    });
    const [url, init] = (vi.mocked(fetch).mock.calls[0] ?? []) as [string, RequestInit];
    expect(url).toBe('https://razorpay.test/v1/payments/pay_1/capture');
    expect(JSON.parse(init.body as string)).toEqual({ amount: 1000 });
  });

  it('captures without a body when no amount is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'pay_2',
        amount: 0,
        currency: 'INR',
        status: 'captured',
        captured: true,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await provider().capturePayment('pay_2');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it('throws the provider error description on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonError({ error: { description: 'Cannot capture' } })),
    );
    await expect(provider().capturePayment('pay_1')).rejects.toThrow('Cannot capture');
  });

  it('throws when the capture payload does not match the expected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'pay_1', amount: 100 })));
    await expect(provider().capturePayment('pay_1')).rejects.toThrow(
      'Invalid Razorpay payment response',
    );
  });
});

describe('RazorpayPaymentProvider — refundPayment', () => {
  it('posts the refund and maps a valid response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 'rfnd_1', status: 'processed', amount: 1000 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await provider().refundPayment({
      paymentId: 'pay_1',
      amountPaise: 1000,
      idempotencyKey: 'idem-rfnd',
    });
    expect(result).toEqual({ id: 'rfnd_1', status: 'processed', amountPaise: 1000 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://razorpay.test/v1/payments/pay_1/refund');
    expect(JSON.parse(init.body as string)).toEqual({ amount: 1000, receipt: 'idem-rfnd' });
  });

  it('throws the provider error description on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonError({ error: { description: 'Refund too large' } })),
    );
    await expect(
      provider().refundPayment({
        paymentId: 'pay_1',
        amountPaise: 9000,
        idempotencyKey: 'idem-rfnd-2',
      }),
    ).rejects.toThrow('Refund too large');
  });

  it('throws when the refund payload does not match the expected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'rfnd_1' })));
    await expect(
      provider().refundPayment({
        paymentId: 'pay_1',
        amountPaise: 100,
        idempotencyKey: 'idem-rfnd-3',
      }),
    ).rejects.toThrow('Invalid Razorpay refund response');
  });
});

describe('RazorpayPaymentProvider — getPayment', () => {
  it('maps a captured payment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: 'pay_1',
          amount: 2500,
          currency: 'INR',
          status: 'captured',
          captured: true,
        }),
      ),
    );
    const result = await provider().getPayment('pay_1');
    expect(result).toMatchObject({
      verified: true,
      paymentId: 'pay_1',
      amountPaise: 2500,
      captured: true,
    });
  });

  it('throws NotFound-style error for a 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false, 404, 'Not Found')));
    await expect(provider().getPayment('pay_missing')).rejects.toThrow('Payment not found');
  });

  it('throws when the payment payload does not match the expected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'pay_1' })));
    await expect(provider().getPayment('pay_1')).rejects.toThrow(
      'Invalid Razorpay payment response',
    );
  });

  it('throws the provider error description on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonError({ error: { description: 'Rate limited' } })),
    );
    await expect(provider().getPayment('pay_1')).rejects.toThrow('Rate limited');
  });
});

describe('RazorpayPaymentProvider — payment id validation', () => {
  const hostile: readonly (readonly [string, string])[] = [
    ['path traversal out of /payments/', '../../../v1/orders'],
    ['single-level traversal', '../refunds'],
    ['absolute url', 'https://evil.test/steal'],
    ['protocol-relative url', '//evil.test/steal'],
    ['query delimiter', 'pay_1?amount=1'],
    ['fragment delimiter', 'pay_1#x'],
    ['encoded traversal', 'pay_1%2F..%2Forders'],
    ['crlf injection', 'pay_1\r\nX-Injected: 1'],
    ['bare newline', 'pay_1\n'],
    ['null byte', 'pay_1 '],
    ['leading whitespace', ' pay_1'],
    ['inner space', 'pay 1'],
    ['empty string', ''],
    ['over-length', `pay_${'a'.repeat(200)}`],
  ];

  it.each(hostile)('rejects %s without issuing a request', async (_label, paymentId) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider().getPayment(paymentId)).rejects.toThrow('Invalid Razorpay payment id');
    await expect(provider().capturePayment(paymentId)).rejects.toThrow(
      'Invalid Razorpay payment id',
    );
    await expect(
      provider().refundPayment({ paymentId, amountPaise: 1, idempotencyKey: 'idem-x' }),
    ).rejects.toThrow('Invalid Razorpay payment id');

    // Fails closed: not one request leaves the process, so the id can never
    // reach the wire in any form.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not echo the rejected id back in the error', async () => {
    const hostileId = 'pay_1\r\nInjected-Header: 1';
    vi.stubGlobal('fetch', vi.fn());

    let message = '<no error thrown>';
    try {
      await provider().getPayment(hostileId);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }

    expect(message).toBe('Invalid Razorpay payment id');
    expect(message).not.toContain('Injected-Header');
    expect(message).not.toContain('\n');
  });

  it('still accepts well-formed ids unchanged', async () => {
    const captured = jsonResponse({
      id: 'pay_ABC123xyz',
      amount: 1000,
      currency: 'INR',
      status: 'captured',
      captured: true,
    });
    const fetchMock = vi.fn().mockResolvedValue(captured);
    vi.stubGlobal('fetch', fetchMock);

    for (const id of ['pay_1', 'pay_ABC123xyz', 'order_1', 'rfnd_1', 'cust_1']) {
      await provider().getPayment(id);
      const [url] = fetchMock.mock.calls.at(-1) as [string];
      expect(url).toBe(`https://razorpay.test/v1/payments/${id}`);
    }
  });
});

describe('RazorpayPaymentProvider - fail-closed signatures', () => {
  it('returns false (not a RangeError) for a wrong-length webhook signature', () => {
    expect(provider().verifyWebhookSignature('{}', 'short')).toBe(false);
  });

  it('rejects a wrong-length payment signature as an invalid signature', async () => {
    await expect(
      provider().verifyPayment({ paymentId: 'pay_1', orderId: 'order_1', signature: 'x' }),
    ).rejects.toThrow('Invalid payment signature');
  });

  it('refuses to sign or verify when the webhook secret is empty', () => {
    const p = new RazorpayPaymentProvider({ ...CONFIG, webhookSecret: '' });
    expect(() => p.verifyWebhookSignature('{}', 'a')).toThrow('not configured');
    expect(() => p.generateSignature({ paymentId: 'p', orderId: 'o' })).toThrow('not configured');
  });
});
