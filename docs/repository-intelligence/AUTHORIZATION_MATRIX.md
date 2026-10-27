# Authorization Matrix

| Surface | Expected authority | Evidence boundary |
|---|---|---|
| Guest public discovery | public/backend policy | Frontend public callers plus backend public routes |
| Guest checkout/orders/wallet | authenticated user + ownership | Session/BFF plus backend route/service tests |
| Partner event/venue/finance | organization membership and role | Frontend org-access plus backend context/policy |
| Scanner/door | device/session/staff policy | Scanner schemas/client plus backend door routes |
| Admin operations | admin policy | Admin routes/services |
| Payment/webhook | provider signature and idempotent backend handling | Adapter/routes/services; staging proof absent |

UI hiding is not authorization. Final acceptance needs deny-case tests for cross-tenant, wrong-role, expired-session, replay, and ownership violations.
