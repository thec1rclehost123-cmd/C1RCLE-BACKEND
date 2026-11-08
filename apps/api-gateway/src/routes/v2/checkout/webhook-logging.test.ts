import { createHmac } from 'node:crypto';
import { Writable } from 'node:stream';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import webhookRoutes from './webhook-routes.js';

/**
 * The webhook route's log output, captured for real. A Razorpay payment entity
 * carries the payer's name, email, phone number and card details; none of it
 * may reach a log line, whether the event is handled, ignored or unparseable.
 */
const WEBHOOK_SECRET = 'test_webhook_secret';
const PERSONAL = ['payer@example.com', '+919999999999', 'A Payer', 'last4', '4111', 'Visa'];

async function capture(body: unknown): Promise<{ status: number; logs: string }> {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const server = Fastify({ logger: { level: 'info', stream } });
  await server.register(webhookRoutes);

  const raw = JSON.stringify(body);
  const response = await server.inject({
    method: 'POST',
    url: '/webhooks/payments/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
    },
    payload: raw,
  });
  await server.close();
  return { status: response.statusCode, logs: lines.join('') };
}

const payer = {
  email: 'payer@example.com',
  contact: '+919999999999',
  card: { name: 'A Payer', last4: '1111', network: 'Visa', token_iin: '4111' },
};

describe('webhook logging carries no personal data', () => {
  it('an event the schema does not model logs only its name and ids', async () => {
    const { status, logs } = await capture({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 12345, order_id: 'order_1', ...payer } } },
    });

    expect(status).toBe(200);
    expect(logs).toContain('razorpay_webhook_unrecognized_payload');
    for (const value of PERSONAL) expect(logs).not.toContain(value);
  });

  it('a signed capture with no hold correlation is logged as an error, ids only', async () => {
    const { status, logs } = await capture({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', notes: [], ...payer } } },
    });

    expect(status).toBe(200);
    expect(logs).toContain('razorpay_webhook_missing_correlation_ids');
    expect(logs).toContain('pay_1');
    expect(logs).toContain('order_1');
    expect(logs).toContain('"level":50');
    for (const value of PERSONAL) expect(logs).not.toContain(value);
  });

  it('an ignored event type logs nothing about the payer either', async () => {
    const { status, logs } = await capture({
      event: 'payment.authorized',
      payload: { payment: { entity: { id: 'pay_2', order_id: 'order_2', notes: [], ...payer } } },
    });

    expect(status).toBe(200);
    for (const value of PERSONAL) expect(logs).not.toContain(value);
  });
});
