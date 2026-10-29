# Repairing stalled order fulfilment

Fulfilling a paid order is several writes: the order, the hold conversion, the promo record, the
tickets, the ledger entries. Each step is idempotent, so a redelivered webhook finishes a
half-done order. They are **not** one database transaction, so a crash between steps can leave a
charged order without its tickets or ledger entry. Razorpay redelivers for about a day; this tool
covers the case where that did not happen.

## What it checks
For each paid order in a recent window: is the hold converted to that order, do all its tickets
exist, and (for a non-zero order) is there a ledger entry. Anything missing is finished using the
same steps fulfilment uses, so nothing is duplicated.

## Running it
```
pnpm --filter api-gateway repair:fulfilment                 # report only (default)
pnpm --filter api-gateway repair:fulfilment -- --apply      # repair what it found
pnpm --filter api-gateway repair:fulfilment -- --hours 72 --settle-minutes 15 --max 1000
```
Needs the real database credentials loaded (`STORAGE_DRIVER=firestore`); it refuses the memory driver.
Exit status is non-zero if any order could not be repaired.

- `--hours` (48): how far back to look.
- `--settle-minutes` (10): ignore orders newer than this; they may still be mid-fulfilment.
- `--max` (500): stop after examining this many; the report says if it stopped early.

## What it will not do
It never touches an order that is not already `paid`, never decides whether a payment happened,
and cannot repair an order whose hold cannot be found (it reports those). It is safe to run twice
or while a webhook is arriving. Run it from a trusted machine after an incident, or on a schedule
once Render cron is set up (not configured).
