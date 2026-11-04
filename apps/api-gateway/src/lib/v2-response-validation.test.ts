import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { validateV2Response } from './v2-response-validation.js';

const publicDto = z.object({
  id: z.string(),
  holder: z.object({ name: z.string() }),
});

describe('V2 response privacy boundary', () => {
  it('serializes the declared DTO without top-level or nested private storage fields', async () => {
    const server = Fastify();
    server.get('/ticket', (request, reply) => {
      const data = validateV2Response(reply, request, publicDto, {
        id: 'ticket-public',
        recipientEmail: 'invited@example.test',
        recipientEmailHash: 'private-email-binding',
        holder: { name: 'Guest', internalNotes: 'private storage data' },
      });
      return reply.sent ? reply : reply.send(data);
    });
    try {
      const response = await server.inject('/ticket');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: 'ticket-public', holder: { name: 'Guest' } });
    } finally {
      await server.close();
    }
  });

  it('fails closed without returning raw storage data when the DTO is invalid', async () => {
    const server = Fastify();
    server.get('/ticket', (request, reply) => {
      const data = validateV2Response(reply, request, publicDto, {
        id: 123,
        recipientEmail: 'private@example.test',
      });
      return reply.sent ? reply : reply.send(data);
    });
    try {
      const response = await server.inject('/ticket');
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('private@example.test');
      expect(response.json()).toMatchObject({ status: 500, code: 'server' });
    } finally {
      await server.close();
    }
  });
});
