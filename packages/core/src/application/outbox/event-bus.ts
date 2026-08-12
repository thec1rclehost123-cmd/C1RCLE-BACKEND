import { OUTBOX_MAX_ATTEMPTS } from '../../domain/ports/outbox.js';

import type { DomainEvent, DomainEventType } from '../../domain/events/domain-events.js';
import type { EntityId } from '../../domain/identity.js';
import type { OutboxReader } from '../../domain/ports/outbox.js';
import type { Logger } from '../../telemetry/logger.js';

/**
 * ─── In-process event bus + outbox relay (T12/T13) ───────────────────────────
 *
 * Services publish; consumers react. No service ever calls another service.
 *
 * Delivery is **at-least-once**, so every consumer must be idempotent. The bus
 * enforces that structurally rather than trusting handlers: it remembers which
 * `(eventId, consumerName)` pairs already succeeded and never re-runs them, so
 * a retry after a partial failure re-runs only the consumers that actually
 * failed.
 */

export type EventHandler = (event: DomainEvent) => Promise<void>;

interface Subscription {
  readonly consumerName: string;
  readonly types: ReadonlySet<DomainEventType>;
  readonly handle: EventHandler;
}

export class EventBus {
  readonly #subscriptions: Subscription[] = [];
  /** `${eventId}::${consumerName}` for consumers that already succeeded. */
  readonly #delivered = new Set<string>();

  constructor(private readonly logger: Logger) {}

  subscribe(consumerName: string, types: readonly DomainEventType[], handle: EventHandler): void {
    this.#subscriptions.push({ consumerName, types: new Set(types), handle });
  }

  /**
   * Delivers to every interested consumer. Throws if any consumer failed, so
   * the caller (the relay) can retry — but consumers that already succeeded
   * are not re-run.
   */
  async publish(event: DomainEvent): Promise<void> {
    const failures: string[] = [];

    for (const subscription of this.#subscriptions) {
      if (!subscription.types.has(event.type)) continue;

      const deliveryKey = `${event.id}::${subscription.consumerName}`;
      if (this.#delivered.has(deliveryKey)) continue;

      try {
        await subscription.handle(event);
        this.#delivered.add(deliveryKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${subscription.consumerName}: ${message}`);
        this.logger.error('event_consumer_failed', {
          eventId: event.id,
          eventType: event.type,
          consumer: subscription.consumerName,
          message,
        });
      }
    }

    if (failures.length > 0) {
      throw new Error(`Event ${event.type} had failing consumers — ${failures.join('; ')}`);
    }
  }

  /** True once this consumer has successfully handled this event. */
  hasDelivered(eventId: EntityId, consumerName: string): boolean {
    return this.#delivered.has(`${eventId}::${consumerName}`);
  }
}

/**
 * Drains pending outbox rows into the bus. In this slice it is driven
 * explicitly (tests, or a dev tick); a scheduler owns it from the next slice —
 * the API process must never run the worker inline in production.
 */
export class OutboxRelay {
  constructor(
    private readonly reader: OutboxReader,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly now: () => Date,
  ) {}

  /** Processes up to `limit` rows. Returns what happened, for observability. */
  async drain(limit = 50): Promise<{ processed: number; failed: number; deadLettered: number }> {
    const pending = await this.reader.listPending(limit);
    let processed = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const record of pending) {
      try {
        await this.bus.publish(record.event);
        await this.reader.markProcessed(record.id, this.now());
        processed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.reader.markFailed(record.id, message, this.now());
        failed++;
        if (record.attempts + 1 >= OUTBOX_MAX_ATTEMPTS) {
          deadLettered++;
          // Never silent: a poisoned row is an operational signal.
          this.logger.error('outbox_dead_letter', {
            outboxId: record.id,
            eventType: record.event.type,
            attempts: record.attempts + 1,
            message,
          });
        }
      }
    }

    return { processed, failed, deadLettered };
  }
}
