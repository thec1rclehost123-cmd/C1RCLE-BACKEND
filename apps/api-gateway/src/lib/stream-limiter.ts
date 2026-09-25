/**
 * ─── Concurrent-stream budget ───────────────────────────────────────────────
 *
 * A streaming endpoint's real denial-of-service vector is not request rate —
 * the rate limiter already bounds that — it is *connection count*. One client
 * that opens streams in a loop and never closes them pins a file descriptor,
 * a timer and a closure each time, and the rate limiter never fires because
 * each open is a single request. Every long-lived connection therefore has to
 * take a slot from a bounded pool before a byte is written.
 *
 * Two limits, because they fail differently:
 *  - **per actor** stops one venue's misbehaving device from crowding out
 *    everyone else;
 *  - **global** stops the sum of well-behaved clients from exhausting the
 *    process, which a per-actor cap alone cannot do.
 *
 * In-memory and per-instance on purpose: the thing being bounded (open
 * sockets on *this* process) is itself per-instance, so a shared counter in
 * Redis would be measuring the wrong thing.
 */

export interface StreamSlot {
  /** Idempotent — safe to call from both a close handler and an error path. */
  release(): void;
}

export interface StreamLimiterOptions {
  maxPerActor?: number;
  maxGlobal?: number;
}

export interface StreamLimiter {
  /** Returns null when the caller is at its limit, or the process is. */
  acquire(actorKey: string): StreamSlot | null;
  /** Open stream count, for tests and diagnostics. */
  size(): number;
}

export function createStreamLimiter(options: StreamLimiterOptions = {}): StreamLimiter {
  // A door has a handful of screens per venue: a couple of scanners and a
  // dashboard. Ten leaves generous headroom while still being a number one
  // buggy client cannot walk past.
  const maxPerActor = options.maxPerActor ?? 10;
  const maxGlobal = options.maxGlobal ?? 500;
  const perActor = new Map<string, number>();
  let total = 0;

  return {
    acquire(actorKey: string): StreamSlot | null {
      const current = perActor.get(actorKey) ?? 0;
      if (current >= maxPerActor || total >= maxGlobal) return null;
      perActor.set(actorKey, current + 1);
      total += 1;

      let released = false;
      return {
        release() {
          // A socket can close and error, and Fastify can also unwind the
          // handler — releasing twice would leak capacity downward until the
          // endpoint refused everyone.
          if (released) return;
          released = true;
          total -= 1;
          const remaining = (perActor.get(actorKey) ?? 1) - 1;
          if (remaining <= 0) perActor.delete(actorKey);
          else perActor.set(actorKey, remaining);
        },
      };
    },
    size(): number {
      return total;
    },
  };
}
