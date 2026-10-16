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
  workerId?: string;
  leaseMs?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  now?: () => number;
}

export class InProcessEventBus implements OutboxWriter {
  private readonly handlers = new Map<string, Set<EventHandler>>();
  /** Best-effort in-process dedupe; durable consumers must enforce sink idempotency. */
  private readonly processedByHandler = new Map<string, Set<EntityId>>();
  /** Stable per-subscription identity (see `handlerKey`). */
  private readonly handlerIds = new WeakMap<EventHandler, number>();
  private nextHandlerId = 0;
  private readonly store: OutboxStore;
  private readonly maxAttempts: number;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: () => number;
  private draining = false;

  constructor(store: OutboxStore, options: EventBusOptions = {}) {
    this.store = store;
    this.maxAttempts = options.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
    this.workerId = options.workerId ?? 'in-process-worker';
    this.leaseMs = options.leaseMs ?? 30_000;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /** OutboxWriter contract: write the event, then drain in the same call. */
  async append(event: DomainEvent): Promise<void> {
    await this.store.append(event);
    await this.drain();
  }

  /** Delegates to the store so the bus honours the full OutboxWriter port. */
  markProcessed(id: EntityId, processedAt: number, leaseToken?: string): Promise<void> {
    return this.store.markProcessed(id, processedAt, leaseToken);
  }

  markFailed(id: EntityId, attempts: number, leaseToken?: string): Promise<void> {
    return this.store.markFailed(id, attempts, leaseToken);
  }

  bumpAttempts(id: EntityId): Promise<number> {
    return this.store.bumpAttempts(id);
  }

  scheduleRetry(
    id: EntityId,
    nextAttemptAt: number,
    error: string,
    leaseToken?: string,
  ): Promise<void> {
    return this.store.scheduleRetry(id, nextAttemptAt, error, leaseToken);
  }

  subscribe(type: string, handler: EventHandler): void {
    const set = this.handlers.get(type) ?? new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(type, set);
    if (!this.handlerIds.has(handler)) this.handlerIds.set(handler, this.nextHandlerId++);
    if (!this.processedByHandler.has(this.handlerKey(type, handler))) {
      this.processedByHandler.set(this.handlerKey(type, handler), new Set<EntityId>());
    }
  }

  /** Pulls pending rows and dispatches. Returns count of rows processed. */
  async drain(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      const pending = await this.store.claimPending({
        workerId: this.workerId,
        now: this.now(),
        leaseMs: this.leaseMs,
      });
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
    leaseToken?: string | null;
  }): Promise<boolean> {
    const handlers = this.handlers.get(row.type);
    const event = row.payload as DomainEvent;
    if (!handlers || handlers.size === 0) {
      // No consumer registered (future projection): mark processed so the
      // pending row does not grow unbounded.
      await this.store.markProcessed(row.id, this.now(), row.leaseToken ?? undefined);
      return true;
    }

    let allSucceeded = true;
    let lastError = 'event handler failed';
    for (const handler of handlers) {
      const key = this.handlerKey(row.type, handler);
      const seen = this.processedByHandler.get(key) ?? new Set<EntityId>();
      if (seen.has(row.id)) continue; // consumer idempotency by event id
      try {
        await handler(event);
        seen.add(row.id);
      } catch (error) {
        allSucceeded = false;
        lastError = error instanceof Error ? error.message.slice(0, 500) : 'event handler failed';
      }
    }

    if (allSucceeded) {
      await this.store.markProcessed(row.id, this.now(), row.leaseToken ?? undefined);
      return true;
    }

    const attempts = (row as { attempts?: number }).attempts ?? 1;
    if (attempts >= this.maxAttempts) {
      await this.store.markFailed(row.id, attempts, row.leaseToken ?? undefined); // DLQ/support required
    } else {
      const delay = Math.min(
        this.baseRetryDelayMs * 2 ** Math.max(0, attempts - 1),
        this.maxRetryDelayMs,
      );
      await this.store.scheduleRetry(
        row.id,
        this.now() + delay,
        lastError,
        row.leaseToken ?? undefined,
      );
    }
    return false;
  }

  /**
   * Keyed by handler identity, not `handler.name`: factory-built consumers
   * (e.g. `createAuditConsumer(...)`) are anonymous, so two of them on one
   * event type used to share a dedupe set and the second silently skipped
   * every event the first had handled.
   */
  private handlerKey(type: string, handler: EventHandler): string {
    return `${type}#${handler.name}#${this.handlerIds.get(handler)}`;
  }
}
