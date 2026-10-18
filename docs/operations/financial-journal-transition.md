# Financial journal transition

The legacy settlement ledger remains the finance read model until a controlled
cutover explicitly selects `financial_journal_v2`. The application must read
one model or the other. It must never add legacy-ledger values to journal
values.

## Backfill and validation

1. Run a dry-run preview. It reads the next organization batch and returns the
   deterministic `legacy_backfill` journals without writing them.
2. Start the resumable backfill. Each journal key is derived from the immutable
   legacy ledger-entry id. A crash after posting but before checkpointing is
   safe: replay resolves the existing journal instead of posting money twice.
3. Continue until `backfillCompletedAt` is set. The singleton transition record
   stores the last completed organization as its checkpoint.
4. Run comparison. For every organization, compare the complete legacy payable
   total with the net credit balance of the host, venue and promoter payable
   journal accounts. Persist every difference in the transition record.
5. Investigate and repair source-specific discrepancies. Re-run comparison;
   do not overwrite or delete legacy entries or posted journals.
6. Cut over only after comparison completed with zero discrepancies. Cutover is
   a separate command and changes only the selected read-model version.

Do not run this process against staging or production until the Milestone 2
approval gate explicitly authorizes it. Before that approval, exercise it only
with the memory driver or Firestore emulator.

## Rollback

If journal reads produce an unexpected result, switch the singleton transition
record back to `legacy_ledger_v1` using the rollback command. Rollback does not
delete journals, reset checkpoints, or mutate legacy history. Capture the
comparison report and affected organization ids, repair the additive journal
data, re-run comparison, and perform a new controlled cutover.

Rollback is a read-model switch, not a data reversal. Never compensate by
combining totals from both stores.
