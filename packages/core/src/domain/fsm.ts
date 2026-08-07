import { StateTransitionError } from './errors.js';

/**
 * ─── Generic finite state machine helper ────────────────────────────────────
 * Shared by all domain aggregates that need explicit allowed-transitions
 * tables. Same-state is an idempotent no-op (callers may retry safely);
 * anything not in the source's allowed list throws `StateTransitionError`.
 */
export function transitionStatus<T extends string>(
  from: T,
  to: T,
  table: Readonly<Record<T, readonly T[]>>,
): T {
  if (from === to) return from;
  const allowed = table[from];
  if (!allowed || !allowed.includes(to)) {
    throw new StateTransitionError(from, to);
  }
  return to;
}
