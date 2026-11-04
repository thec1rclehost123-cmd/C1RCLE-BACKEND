import { InvalidOperationError } from '../errors.js';

interface TicketTarget {
  id: string;
  tierId: string;
  status: string;
}
interface TicketLine {
  tierId: string;
  quantity: number;
}
/** Locks the requested identity, never a guessed attendee chosen by ordering. */
export function selectRefundTargets(
  tickets: readonly TicketTarget[],
  input: { targetEntitlementIds?: readonly string[]; ticketLines?: readonly TicketLine[] },
): { targetEntitlementIds: string[]; ticketLines: TicketLine[] } {
  const eligible = tickets.filter((ticket) => ticket.status !== 'void');
  const lines = input.ticketLines ?? [];
  const ids = [...(input.targetEntitlementIds ?? [])];
  if (input.targetEntitlementIds) {
    if (ids.length === 0 || ids.length > 100 || new Set(ids).size !== ids.length)
      throw new InvalidOperationError('Select unique specific tickets for this refund');
    if (ids.some((id) => !eligible.some((ticket) => ticket.id === id)))
      throw new InvalidOperationError('Selected ticket does not belong to this refundable order');
  } else if (lines.length) {
    const seen = new Set<string>();
    for (const line of lines) {
      const matches = eligible.filter((ticket) => ticket.tierId === line.tierId);
      if (
        seen.has(line.tierId) ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity !== matches.length
      )
        throw new InvalidOperationError(
          'Select the specific ticket identities for a partial tier refund',
        );
      seen.add(line.tierId);
      ids.push(...matches.map((ticket) => ticket.id));
    }
  }
  const counts = new Map<string, number>();
  for (const id of ids) {
    const ticket = eligible.find((row) => row.id === id);
    if (!ticket) throw new InvalidOperationError('Selected ticket is unavailable');
    counts.set(ticket.tierId, (counts.get(ticket.tierId) ?? 0) + 1);
  }
  const selectedLines = [...counts].map(([tierId, quantity]) => ({ tierId, quantity }));
  if (
    input.targetEntitlementIds &&
    lines.length &&
    (lines.length !== selectedLines.length ||
      lines.some((line) => counts.get(line.tierId) !== line.quantity) ||
      new Set(lines.map((line) => line.tierId)).size !== lines.length)
  )
    throw new InvalidOperationError(
      'Selected ticket identities do not match refund tier quantities',
    );
  return { targetEntitlementIds: ids, ticketLines: selectedLines };
}
