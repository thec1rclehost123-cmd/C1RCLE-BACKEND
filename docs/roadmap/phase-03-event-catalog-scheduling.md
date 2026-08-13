# Phase 3 — Event-catalog & scheduling

**Status:** not started · **Depends on:** Phase 0

The cheapest phase to build: `EventCatalogService` (tiers/promotions/tables/
promoter-assignments, create+list+end) and `VenueCalendarService`/
`VenueSlotRequestService` already exist and are tested in
`packages/core/src/application/**` — this phase is **routes only**, same
"free win" pattern as Phase 0's B11 gap-closing.

## Routes to add

- `GET/POST /events/:eventId/ticket-tiers`, promo codes, table packages,
  promoter-assignments (per `task.md`'s note: "event-catalog *writes*" are
  listed BLOCKED in the Phase-0 slice specifically because routes didn't
  exist yet — the service layer was always there).
- Venue calendar/slot-request routes land in Phase 0 already (they're part of
  the frozen slice); this phase is specifically the **event-catalog** side.

## v1 proven logic to port (`thec1rcle`)

- **Ticket tier schema**: `id, name, entryType(stag|couple|group|general|vip|table),
  price/basePrice, quantity, remaining, salesStart/salesEnd, minPerOrder/
  maxPerOrder, promoterEnabled, promoterCommission, promoterDiscount,
  discounts[], scheduledPrices[]` (early-bird/regular/last-call windows).
- **Effective price resolution** (`pricing-engine.js getEffectivePrice`):
  check `tier.scheduledPrices[]` for a window containing `now`, else
  `basePrice ?? price ?? 0`.
- **Promo codes** (`promo-service.js`, collections `promo_codes`/
  `promo_redemptions`): types `public|private|single_use|multi_use`,
  `discountType: percent|fixed`, `tierIds[]` (empty = all), `maxRedemptions`/
  `maxPerUser`, validity window. Race protection via Redis counters before
  Firestore write; redemption doc keyed deterministically by `orderId`
  (idempotent). Discount calc: `percent → round(subtotal * value/100)`,
  `fixed → min(value, subtotal)`.
- **Table packages** (`table-engine.js`, collections `venue_tables`,
  `table_assignments`): venue floor-plan CRUD + per-event table→booking
  assignment, doc id `{eventId}_{tableId}`, statuses `assigned|occupied|released`.
- **Promoter assignment / commission on events** (`promoter-engine.js`):
  commission formula — `orderAmount===0 → 0` (hard rule, no payout on free
  tickets); `percentage → round(orderAmount * (rate ?? 15) / 100)`;
  `flat → rate ?? 50` (flat ₹ per order, not per ticket). Event must have
  `promotersEnabled` and (if set) promoter must be in `allowedPromoterIds`.

## Firestore collections

`v2_event_catalog_tiers`, `v2_event_catalog_promos`, `v2_promo_redemptions`,
`v2_event_catalog_tables`, `v2_table_assignments`,
`v2_event_catalog_promoter_assignments`.

## Session Log

(none yet)
