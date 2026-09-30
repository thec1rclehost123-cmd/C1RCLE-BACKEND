import { describe, expect, it } from 'vitest';

import { InvalidOperationError } from './errors.js';
import {
  addAdminReply,
  addCustomerMessage,
  addInternalNote,
  assignTicket,
  changeTicketPriority,
  closeTicket,
  createSupportTicket,
  deleteTicket,
  escalateTicket,
  linkTicket,
  mergeDuplicateTicket,
  refreshSla,
  reopenTicket,
  resolveTicket,
  restoreTicket,
  slaFor,
} from './models/support-ticket.js';

import type { SupportTicket } from './models/support-ticket.js';

const T0 = new Date('2026-08-14T12:00:00.000Z');

function ticket(overrides: Partial<Parameters<typeof createSupportTicket>[0]> = {}): SupportTicket {
  return createSupportTicket({
    id: 'tkt_1',
    subject: 'Forgot my ticket at the door',
    description: 'I bought two tickets but one did not scan at entry.',
    category: 'order',
    priority: 'high',
    requester: { userId: 'usr_1', email: 'guest@example.com', organizationId: null },
    now: T0,
    ...overrides,
  });
}

const admin = { userId: 'adm_1', name: 'Support Agent' };

function hoursFrom(t: Date, hours: number): string {
  return new Date(t.getTime() + hours * 60 * 60 * 1000).toISOString();
}

describe('creating a support ticket', () => {
  it('starts open with the given priority and requester', () => {
    const t = ticket();
    expect(t.status).toBe('open');
    expect(t.priority).toBe('high');
    expect(t.category).toBe('order');
    expect(t.requester.userId).toBe('usr_1');
    expect(t.assignee).toBeNull();
    expect(t.messages).toEqual([]);
    expect(t.mergedInto).toBeNull();
    expect(t.mergedFrom).toEqual([]);
    expect(t.deletedAt).toBeNull();
  });

  it('sets a response and resolution deadline from the priority', () => {
    const t = ticket({ priority: 'high', now: T0 });
    expect(t.sla.responseDueAt).toBe(hoursFrom(T0, 4));
    expect(t.sla.resolutionDueAt).toBe(hoursFrom(T0, 24));
    expect(t.sla.responseBreachedAt).toBeNull();
    expect(t.sla.resolutionBreachedAt).toBeNull();
  });

  it('rejects an empty subject or description', () => {
    expect(() => ticket({ subject: '   ' })).toThrow(InvalidOperationError);
    expect(() => ticket({ description: '   ' })).toThrow(InvalidOperationError);
  });
});

describe('SLA targets', () => {
  it('offers stricter windows for urgent tickets than low ones', () => {
    expect(slaFor('urgent', T0).responseDueAt).toBe(hoursFrom(T0, 1));
    expect(slaFor('urgent', T0).resolutionDueAt).toBe(hoursFrom(T0, 4));
    expect(slaFor('low', T0).responseDueAt).toBe(hoursFrom(T0, 72));
    expect(slaFor('low', T0).resolutionDueAt).toBe(hoursFrom(T0, 168));
  });

  it('flags a breached response while the customer is still waiting', () => {
    const t = ticket({ priority: 'urgent', now: T0 });
    const late = new Date(T0.getTime() + 2 * 60 * 60 * 1000); // 2h after the 1h response SLA
    const refreshed = refreshSla(t, late);
    expect(refreshed.responseBreachedAt).toBe(late.toISOString());
    // Resolution window (4h) is not breached yet, so no resolution breach.
    expect(refreshed.resolutionBreachedAt).toBeNull();
  });

  it('an admin reply clears the response breach and re-arms the clock', () => {
    const t = ticket({ priority: 'urgent', now: T0 });
    const late = new Date(T0.getTime() + 2 * 60 * 60 * 1000);
    const breached = refreshSla(t, late);
    expect(breached.responseBreachedAt).not.toBeNull();
    const replied = addAdminReply(t, admin, 'On it.', late);
    expect(replied.sla.responseBreachedAt).toBeNull();
    expect(replied.sla.responseDueAt).toBe(hoursFrom(late, 1));
  });

  it('a resolution breach appears only once the ticket stays unresolved past its window', () => {
    const t = ticket({ priority: 'urgent', now: T0 });
    const veryLate = new Date(T0.getTime() + 5 * 60 * 60 * 1000); // past the 4h resolution SLA
    const refreshed = refreshSla(t, veryLate);
    expect(refreshed.resolutionBreachedAt).toBe(veryLate.toISOString());
  });
});

describe('messages', () => {
  it('adds a customer message and moves waiting_on_customer back to in_progress', () => {
    const base = assignTicket(ticket(), admin, T0);
    const waiting = addAdminReply(
      base,
      admin,
      'We are looking into it.',
      new Date(T0.getTime() + 1000),
    );
    expect(waiting.status).toBe('waiting_on_customer');
    const followUp = addCustomerMessage(waiting, 'Any update?', new Date(T0.getTime() + 2000));
    expect(followUp.status).toBe('in_progress');
    const message = followUp.messages.at(-1);
    expect(message?.senderRole).toBe('customer');
    expect(message?.senderId).toBe('usr_1');
  });

  it('an admin reply is a separate message that sets waiting_on_customer', () => {
    let t = ticket();
    t = addAdminReply(t, admin, 'Here is your replacement code.', new Date(T0.getTime() + 5000));
    const original = t;
    const last = original.messages.at(-1);
    expect(last?.senderRole).toBe('admin');
    expect(last?.senderName).toBe('Support Agent');
    expect(original.status).toBe('waiting_on_customer');
  });

  it('rejects empty messages and replies', () => {
    expect(() => addCustomerMessage(ticket(), '   ')).toThrow(InvalidOperationError);
    expect(() => addAdminReply(ticket(), admin, '   ')).toThrow(InvalidOperationError);
  });

  it('rejects a customer follow-up on a resolved ticket', () => {
    const resolved = resolveTicket(ticket(), admin.userId, 'Replacement issued', T0);
    expect(() => addCustomerMessage(resolved, 'Thanks!', T0)).toThrow(InvalidOperationError);
  });
});

describe('desk lifecycle', () => {
  it('assigning an open ticket makes it in_progress with an assignee', () => {
    const t = assignTicket(ticket(), admin, T0);
    expect(t.status).toBe('in_progress');
    expect(t.assignee).toEqual(admin);
  });

  it('changeTicketPriority re-arms the SLA from now (the v2 real-SLA improvement)', () => {
    const t = changeTicketPriority(ticket({ priority: 'low', now: T0 }), 'urgent', T0);
    expect(t.priority).toBe('urgent');
    expect(t.sla.responseDueAt).toBe(hoursFrom(T0, 1));
    expect(t.sla.resolutionDueAt).toBe(hoursFrom(T0, 4));
  });

  it('links one entity to the ticket at a time', () => {
    const t = linkTicket(ticket(), { orderId: 'ord_9' }, admin.userId, T0);
    expect(t.links.orderId).toBe('ord_9');
    expect(t.links.venueId).toBeNull();
  });

  it('rejects a link call with no entity', () => {
    expect(() => linkTicket(ticket(), {}, admin.userId, T0)).toThrow(InvalidOperationError);
  });

  it('escalate and resolve and close stamp the ticket', () => {
    let t = escalateTicket(ticket(), admin.userId, T0);
    expect(t.status).toBe('escalated');
    t = resolveTicket(t, admin.userId, 'Handed to technical team', T0);
    expect(t.status).toBe('resolved');
    expect(t.resolvedBy).toBe(admin.userId);
    expect(t.resolvedAt).toBe(T0.toISOString());
    t = closeTicket(t, admin.userId, T0);
    expect(t.status).toBe('closed');
    expect(t.closedBy).toBe(admin.userId);
    expect(t.closedAt).toBe(T0.toISOString());
  });

  it('reopen re-opens a resolved ticket and refreshes its SLA', () => {
    const resolved = resolveTicket(ticket(), admin.userId, 'Fixed', T0);
    const reopened = reopenTicket(resolved, admin.userId, T0);
    expect(reopened.status).toBe('open');
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.closedAt).toBeNull();
    expect(reopened.sla.responseDueAt).toBe(hoursFrom(T0, 4)); // high-priority target
  });

  it('does not reopen a ticket that is not resolved or closed', () => {
    expect(() => reopenTicket(ticket(), admin.userId, T0)).toThrow(InvalidOperationError);
  });
});

describe('merging tickets (v1 semantics)', () => {
  function ctx(now: Date) {
    const primary = addCustomerMessage(ticket({ id: 'tkt_1', now }), 'First note', now);
    const duplicate = createSupportTicket({
      id: 'tkt_2',
      subject: 'Duplicate: forgot my ticket',
      description: 'Same issue as my earlier report.',
      category: 'order',
      priority: 'high',
      requester: { userId: 'usr_1', email: 'guest@example.com', organizationId: null },
      now,
    });
    const withMsg = addCustomerMessage(
      duplicate,
      'Secondary note',
      new Date(now.getTime() + 60000),
    );
    return { primary, duplicate: withMsg };
  }

  it("absorbs the duplicate's messages into the primary and closes the duplicate", () => {
    const { primary, duplicate } = ctx(T0);
    const { primary: merged, duplicate: closed } = mergeDuplicateTicket(
      primary,
      duplicate,
      admin.userId,
      T0,
    );
    expect(closed.status).toBe('closed');
    expect(closed.mergedInto).toBe('tkt_1');
    expect(merged.mergedFrom).toEqual(['tkt_2']);
    const annotated = merged.messages.filter((m) => m.content.includes('[Merged from ticket'));
    expect(annotated).toHaveLength(1);
    // The absorbed message stays in the combined thread in creation order.
    const dates = merged.messages.map((m) => new Date(m.createdAt).getTime());
    expect([...dates]).toEqual([...dates].sort((a, b) => a - b));
  });

  it('refuses a self-merge and a re-merge', () => {
    const { primary, duplicate } = ctx(T0);
    expect(() => mergeDuplicateTicket(primary, primary, admin.userId, T0)).toThrow(
      InvalidOperationError,
    );
    const { primary: merged } = mergeDuplicateTicket(primary, duplicate, admin.userId, T0);
    expect(() => mergeDuplicateTicket(merged, duplicate, admin.userId, T0)).toThrow(
      InvalidOperationError,
    );
  });
});

describe('soft delete', () => {
  it('marks the ticket deleted with attribution, never a hard delete', () => {
    const t = deleteTicket(ticket(), admin.userId, T0);
    expect(t.deletedAt).toBe(T0.toISOString());
    expect(t.deletedBy).toBe(admin.userId);
  });

  it('restores a deleted ticket and clears the attribution', () => {
    const restored = restoreTicket(deleteTicket(ticket(), admin.userId, T0), admin.userId, T0);
    expect(restored.deletedAt).toBeNull();
    expect(restored.deletedBy).toBeNull();
  });

  it('rejects a double delete and a restore of an active ticket', () => {
    expect(() => deleteTicket(deleteTicket(ticket(), admin.userId, T0), admin.userId, T0)).toThrow(
      InvalidOperationError,
    );
    expect(() => restoreTicket(ticket(), admin.userId, T0)).toThrow(InvalidOperationError);
  });

  it('internal notes stay visible on the ticket and are never customer-facing', () => {
    const t = addInternalNote(ticket(), admin, 'Requester verified via ID.', T0);
    expect(t.internalNotes).toHaveLength(1);
    const note = t.internalNotes.at(0);
    expect(note?.authorId).toBe(admin.userId);
    expect(note?.content).toBe('Requester verified via ID.');
    expect(t.messages).toHaveLength(0);
  });
});
