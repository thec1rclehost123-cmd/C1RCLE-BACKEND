# Cross-Repository Dependencies

| Frontend route/caller | BFF/client | Contract | Backend route/service | Persistence/downstream |
|---|---|---|---|---|
| Guest discovery/event | public-data/API client | event/public schemas | public/event services | event/venue catalog |
| Checkout/confirmation | checkout and recovery callers | checkout/order/payment schemas | checkout/payment/order services | inventory, orders, tickets, journals |
| Tickets/wallet | wallet/order callers | order/ticket schemas | wallet/order/door services | entitlements, scan state |
| Partner calendar/events | slot/event repositories and BFF | partner/onboarding/event schemas | venue/event/organization services | slots, events, org membership |
| Partner finance | finance repositories | finance/payout/refund schemas | finance/refund/payout services | journals, payables, payouts |
| Scanner | scanner API client | door/scanner schemas | door/scanner services | check-ins, sales, audit |
| Notifications | UI status/support | email/notification contracts where present | email sender/delivery/outbox paths | delivery records/provider |

The frontend report links to the backend report at `../../../../C1RCLE-M3-BACKEND/docs/repository-intelligence/`; the backend counterpart uses the reciprocal path.
