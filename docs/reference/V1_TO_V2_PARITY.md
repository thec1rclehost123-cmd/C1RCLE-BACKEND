# V1 → V2 Parity Report

**Status:** snapshot as of the B09/parity pass.
**Source of truth:** the previous production backend (`thec1rcle/apps/api-gateway/src/routes/v1/`): its proven field names, defaults, and behaviors — not its bugs.
**Guarded by:** `packages/core/src/domain/v1-parity.test.ts` (CI-locked field names).

---

## 1. Conventions (deliberate V2 differences)

| Concern | V1 (proven) | V2 (kept) | Boundary note (B12 adapter) |
|---|---|---|---|
| Money | whole rupees (`totalRevenue`, `price`, `avgTicketPrice`) | paise (`*Paise`, `priceInPaise`, `discountValue`) | Convert rupees→paise when adapting V1 Firestore docs; never change V2 models to rupees |
| City on venue | top-level `city` field | `address.city` on the model; DTO flattens to `city` | Adapter must translate `city` ↔ `address.city` |
| Event lifecycle | free-form string soup (`draft`, `live`, `completed`, `cancelled`, …) | typed FSM `draft → review → scheduled → published` (+ `cancelled`) via `transitionEventStatus` | Map V1 strings to FSM states at read; `publish()` requires `scheduled` first |
| Envelope | 3 inconsistent variants (`{msg,…}`, `{status,message}`, `{ok:false,…}`) | bare DTO + **flat** `{ code, message, fieldErrors, requestId, status }` — corrected 2026-08-13, this table previously described a nested `{ error: {…} }` shape that D-009 removed as unparseable by the frontend | Contract fixed at gateway; no per-app variants |
| Pagination | `{ data, hasMore, nextCursor }` (dual-keyed) | `Page<T>` has `items`, `total`, `nextCursor`; wire shape `pageInfo { page, pageSize, total, hasNextPage }` | Keep both: cursor is opaque; `total` is real (never `items.length`) |
| Roles | `OWNER/MANAGER/FINANCE_ADMIN/STAFF/SECURITY/DOOR` | `owner/admin/manager/member` | Org membership contract fixed; map V1 roles at adapter |
| Slot countering | `requested`/`approved`/`occupied` counters + `source`/`responseMessage` | `SlotRequest`/`VenueSlot` present; countering NOT implemented | Documented as future work, not silently re-created |

## 2. Field-level mapping (kept / renamed / added)

### Events + Catalog

| V1 proven | V2 model field | Outcome |
|---|---|---|
| promo `code` | `PromoCode.code` | kept |
| promo `name` | `PromoCode.name` | added (defaults to code) |
| promo `type` (`public/private/single_use/multi_use`) | `PromoCode.type` | added |
| promo `discountType`, `discountValue` | same | kept |
| promo `tierIds` (empty = all) | `PromoCode.tierIds` | kept |
| promo `maxRedemptions` | `PromoCode.maxRedemptions` | renamed from `maxUses` |
| promo `maxPerUser` | `PromoCode.maxPerUser` | renamed from `maxPerUser` (same) |
| promo `redemptionCount` | `PromoCode.redemptionCount` | kept |
| promo `startsAt`, `endsAt` | `PromoCode.startsAt`, `endsAt` | renamed from `validFrom`/`validUntil` |
| promo `isActive` | computed (status/schedule) | dropped as stored field |
| tier `name`, `description` | `TicketTier.name`, `description` | added description |
| tier `entryType` (default `general`) | `TicketTier.entryType` | added |
| tier `price` (rupees) | `TicketTier.priceInPaise` | renamed + paise |
| tier `quantity` | `TicketTier.quantity` | kept |
| tier `minPerOrder`, `maxPerOrder` | `TicketTier.minPerOrder`, `maxPerOrder` | added |
| tier `salesStart`, `salesEnd` | `TicketTier.salesStartAt`, `salesEndAt` | renamed |
| tier `isHidden`, `status` | `TicketTier.status` | simplified; `isHidden` dropped |
| tier `currency` (default `INR`) | `TicketTier.currency` | added |
| event `slug` | `Event.slug` (`slugifyEventTitle`, fallback = id) | added |
| event `imageUrl` | `Event.imageUrl` | added to create |

### Venues

| V1 proven | V2 model field | Outcome |
|---|---|---|
| `name`, `slug` | `Venue.public.name`, `slug` | kept |
| `description` | `Venue.public.description` | now settable at CREATE (was empty until first update) |
| `capacity` | `Venue.public.capacity` | now settable at CREATE |
| `city` (top-level) | `Venue.public.address.city` (+ DTO flatten `city`) | moved + flattened; adapter translates |
| `contactEmail`/`contactPhone` (`email`/`phone` variants) | `Venue.private.contactEmail`/`contactPhone` | kept on private profile (never in public DTO) |
| `facilities`, `operatingHours`, `photos`, `coverImage`, `profileImage` | public profile fields | kept (partial: photos/cover/operatingHours pending write surface) |

### Organizations

| V1 proven | V2 model field | Outcome |
|---|---|---|
| `name`, `displayName` | `Organization.name`, `slug` | kept |
| `hostType`, `bio`, `tagline`, `profileImage`, `coverImage`, `socialLinks` | org profile | kept (pending profile write surface) |
| `contactEmail`, `contactPhone` | org contact | kept |
| `defaultTimezone` | settings | kept |
| `defaultCurrency` (proven INR) | `OrganizationSettings.defaultCurrency` | added |
| `publicProfileEnabled`, `notificationPreferences`, `bookingPolicy` | pending | follow-up |
| members (`partner_memberships`: `{uid, partnerId, partnerType, role, isActive, joinedAt}`) | `OrganizationMember` (`addMember`/`updateMemberRole`/`removeMember`, `role: owner|admin|manager|member`) | mapped at adapter |
| invites (`host_team_invitations`: `{email, phone, role, status, inviteToken, inviteExpires}`) | member invites | follow-up (tokens/expiry) |

### Analytics

| V1 proven | V2 field | Outcome |
|---|---|---|
| `totalRevenue` (rupees) | `OrganizationOverview.totalRevenuePaise` / `EventAnalytics.totalRevenuePaise` | renamed + paise |
| `totalTicketsSold` (+ `ticketsSold`) | `OrganizationOverview.totalTicketsSold` / `EventAnalytics.ticketsSold` | kept |
| `totalCheckIns` | both models `totalCheckIns` | kept |
| `eventCount` | `OrganizationOverview.totalEvents` (+ `publishedEvents`) | kept |
| `topEvents` `[{id,title,revenue,tickets,date}]` | `OrganizationOverview.topEvents: TopEvent[]` (`{eventId,title,revenuePaise,ticketsSold,startAt}`) | kept shape, paise |
| `capacity`, `views`, `guestlistSignups` | `EventAnalytics` same names | kept |
| `avgTicketPrice` | `avgTicketPricePaise` | renamed + paise |
| `occupancyRate`, `sellThroughRate`, `refundRate`, `noShowRate` | same | kept |
| `refundAmount` | `refundAmountPaise` | renamed + paise |
| `repeatGuests`, `conversionRate` | `EventAnalytics` (conversion precomputed nullable) | kept |

## 3. B12 adapter rules (Firestore boundary)

1. **Money:** every rupee field read from V1 docs converts to paise on write (`* 100`); every V2 paise field converts back on read. Rounding: floor, never float drift.
2. **City:** V1 `venue.city` (top-level) ↔ V2 `venue.public.address.city`. DTO already flattens `city` on the wire.
3. **Lifecycle:** map V1 lifecycle strings → FSM states; unknown strings map to `draft` and log a warning (never throw the whole doc).
4. **Roles:** map V1 role strings → V2 role enum at the org-membership boundary.
5. **Slug backfill:** V1 events may lack `slug` — derive `slugifyEventTitle(title) || id` during migration, then write-once.
6. **Analytics:** compute precomputed ratios/aggregates on the first read after migration (V1 docs may be missing `occupancyRate` etc.); zero-default fallback already in `analytics-service`.

## 4. Explicitly NOT carried over (V1 bugs)

- `||` swallow of `0` defaults (e.g., `fees.gst`, conversionRate) → `??` with explicit null handling.
- `data.userId` impersonation of JWT auth (V2 uses `context.auth?.uid` only).
- Webhook signature auth via non-deterministic serialization (V2 uses deterministic `JSON.stringify`).
- Stale-JWT claim fast paths & `Promise.race`-style double-ticket races (removed in V2 gateway).