import { ConflictError } from '../domain/errors.js';

import type { FinancialJournal } from '../domain/models/financial-journal.js';

const payables = new Set(['host_payable', 'venue_payable', 'promoter_payable', 'partner_payable']);
export function isPayableCorrection(journal: FinancialJournal): boolean {
  return (
    ['refund', 'partner_dispute_reversal'].includes(journal.source.type) &&
    journal.lines.some((line) => line.side === 'debit' && payables.has(line.account))
  );
}

/** Called inside the same critical section that persists the journals. */
export function assertPayableCorrections(
  existing: FinancialJournal[],
  incoming: FinancialJournal[],
): void {
  const fresh = incoming.filter(
    (item) => !existing.some((prior) => prior.idempotencyKey === item.idempotencyKey),
  );
  const corrections = fresh.filter(isPayableCorrection);
  const key = (line: FinancialJournal['lines'][number]) =>
    JSON.stringify([line.organizationId, line.account]);
  for (const correction of corrections) {
    const touched = new Set(
      correction.lines
        .filter((line) => line.side === 'debit' && payables.has(line.account))
        .map(key),
    );
    const related = existing.filter((item) => item.source.orderId === correction.source.orderId);
    if (
      correction.source.type === 'partner_dispute_reversal' &&
      related.some(
        (item) =>
          item.source.type === 'refund' &&
          item.lines.some((line) => line.side === 'debit' && touched.has(key(line))),
      )
    )
      throw new ConflictError(
        'The disputed payable has an existing refund correction; use a separately approved adjustment',
      );
    for (const account of touched) {
      const balance = [
        ...related,
        ...fresh.filter((item) => item.source.orderId === correction.source.orderId),
      ].reduce(
        (sum, item) =>
          sum +
          item.lines
            .filter((line) => key(line) === account)
            .reduce(
              (value, line) =>
                value +
                (line.side === 'credit' ? BigInt(line.amountPaise) : -BigInt(line.amountPaise)),
              0n,
            ),
        0n,
      );
      if (balance < 0n)
        throw new ConflictError(
          'Payable correction changed concurrently; reload the original remaining allocation',
        );
    }
  }
}
