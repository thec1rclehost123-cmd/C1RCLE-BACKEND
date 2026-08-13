/**
 * ─── T13 in-process EventBus ──────────────────────────────────────────────────
 * Drains the outbox and dispatches each event to its handlers exactly once per
 * row lifecycle. Consumer idempotency is by event id (a handler that already
 * saw an event id never sees it again even across retries); delivery is
 * at-least-once, side effects are guarded by dedupe sets per consumer.
 */

import { OUTBOX_MAX_ATTEMPTS } from '../../domain/ports/outbox.js';

import type { DomainEvent } from '../../domain/events.js';
import type { EntityId } from '../../domain/identity.js';
import type { OutboxStore, OutboxWriter } from '../../domain/ports/outbox.js';

export type EventHandler = (event: DomainEvent) => Promise<void>;

export interface EventBusOptions {
  /** Retries before a row goes to the DLQ (default: outbox max attempts). */
  maxAttempts?: number;
}

export class InProcessEventBus implements OutboxWriter {
  private readonly handlers = new Map<string, Set<EventHandler>>();
  /** Idempotency by event id per handler (dedupe), survives bus restarts. */
  private readonly processedByHandler = new Map<string, Set<EntityId>>();
  private readonly store: OutboxStore;
  private readonly maxAttempts: number;
  private draining = false;

  constructor(store: OutboxStore, options: EventBusOptions = {}) {
    this.store = store;
    this.maxAttempts = options.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
  }

  /** OutboxWriter contract: write the event, then drain in the same call. */
  async append(event: DomainEvent): Promise<void> {
    await this.store.append(event);
    await this.drain();
  }

  /** Delegates to the store so the bus honours the full OutboxWriter port. */
  markProcessed(id: EntityId, processedAt: number): Promise<void> {
    return this.store.markProcessed(id, processedAt);
  }

  markFailed(id: EntityId, attempts: number): Promise<void> {
    return this.store.markFailed(id, attempts);
  }

  bumpAttempts(id: EntityId): Promise<number> {
    return this.store.bumpAttempts(id);
  }

  subscribe(type: string, handler: EventHandler): void {
    const set = this.handlers.get(type) ?? new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(type, set);
    if (!this.processedByHandler.has(handlerKey(type, handler))) {
      this.processedByHandler.set(handlerKey(type, handler), new Set<EntityId>());
    }
  }

  /** Pulls pending rows and dispatches. Returns count of rows processed. */
  async drain(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      const pending = await this.store.listPending();
      let processed = 0;
      for (const row of pending) {
        const handled = await this.dispatchRow(row);
        if (handled) processed += 1;
      }
      return processed;
    } finally {
      this.draining = false;
    }
  }

  private async dispatchRow(row: {
    id: EntityId;
    type: string;
    payload: unknown;
  }): Promise<boolean> {
    const handlers = this.handlers.get(row.type);
    const event = row.payload as DomainEvent;
    if (!handlers || handlers.size === 0) {
      // No consumer registered (future projection): mark processed so the
      // pending row does not grow unbounded.
      await this.store.markProcessed(row.id, Date.now());
      return true;
    }

    let allSucceeded = true;
    for (const handler of handlers) {
      const key = handlerKey(row.type, handler);
      const seen = this.processedByHandler.get(key) ?? new Set<EntityId>();
      if (seen.has(row.id)) continue; // consumer idempotency by event id
      try {
        await handler(event);
        seen.add(row.id);
      } catch {
        allSucceeded = false;
      }
    }

    if (allSucceeded) {
      await this.store.markProcessed(row.id, Date.now());
      return true;
    }

    const attempts = await this.store.bumpAttempts(row.id);
    if (attempts >= this.maxAttempts) {
      await this.store.markFailed(row.id, attempts); // DLQ
    }
    return false;
  }
}

function handlerKey(type: string, handler: EventHandler): string {
  return `${type}#${handler.name}`;
}
