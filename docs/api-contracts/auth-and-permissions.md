# Authentication and permissions contract

**Status:** frontend integration contract draft
**Backend reference:** docs/partner-dashboard-v2/AUTHORIZATION_MODEL.md and
docs/partner-dashboard-v2/API_V2_SPEC.md.

## Session boundary

The frontend calls GET /api/v2/session through @c1rcle/api-client.

The response must contain:

~~~json
{
  "data": {
    "user": { "id": "user_123", "email": "person@example.com", "displayName": "Person" },
    "activeOrganizationId": "org_123",
    "memberships": [
      { "organizationId": "org_123", "role": "OWNER", "status": "ACTIVE" }
    ],
    "permissions": ["organization.read", "event.read"]
  },
  "meta": { "requestId": "uuid", "nextCursor": null }
}
~~~

The server is authoritative for user identity, active organization, membership,
role, approval/KYC state, suspension, and effective permissions.

## Credential behavior

- Browser clients use the approved session cookie or short-lived bearer token.
- Tokens are never written to localStorage, sessionStorage, URLs, analytics, or
  logs.
- The API client attaches credentials centrally; pages do not build auth headers.
- On 401, the client/session boundary may refresh once. If that fails, clear
  session state and render the sign-in boundary.
- On 403, keep the session and show permission denied.
- On logout, invalidate local server-state caches and remove session state.
- A session bootstrap must complete before private profile/ticket UI claims the
  user is anonymous.

## Organization context

- GET /api/v2/organizations lists accessible organizations.
- The selected organization is sent through the approved path or
  X-Organization-Id when the endpoint requires context.
- The backend verifies that the user is an active member of that organization.
- An organization ID in the request body is never trusted by itself.
- Switching organization clears or scopes cached queries before loading the new
  context.
- Revoked/suspended membership fails closed and invalidates relevant caches.

## Role and permission model

Canonical roles are OWNER, ADMIN, EVENT_MANAGER, FINANCE_MANAGER,
MARKETING_MANAGER, DOOR_MANAGER, PROMOTER, and VIEWER. Legacy role strings are
compatibility adapters, not new frontend policy.

Permission examples:

| Area | Permissions |
| --- | --- |
| Organization | organization.read, organization.manage, staff.read, staff.manage |
| Venue/events | venue.read, venue.manage, event.read, event.create, event.update, event.publish, event.cancel |
| Commerce | order.read, refund.create, refund.approve |
| Finance | finance.read, payout.request, payout.approve, bank_account.manage |
| Guests/door | guest.read, guest.export, door.read, ticket.check_in, ticket.override |
| Campaigns/analytics | campaign.read, campaign.create, campaign.send, analytics.read |
| Audit | audit.read |

The frontend may hide navigation or disable actions for usability. It never
grants access. Every protected backend route checks authentication, membership,
permission, and resource scope.

## Data visibility

Backend DTOs must project fields by caller:

- Guest: own order/ticket/profile data only.
- Promoter: assigned/attributed events, own earnings, minimized guest data.
- Door staff: event/door data required for check-in, not finance.
- Finance staff: approved finance/order projection, not unrelated guest PII.
- Admin/owner: only fields allowed by explicit permission and policy.

## Required frontend states

| State | Meaning | UI behavior |
| --- | --- | --- |
| unknown | Session bootstrap pending | Loading shell; do not flash logged-out UI |
| anonymous | No valid session | Public UI or sign-in boundary |
| authenticated | Valid session | Load active organization and scoped data |
| forbidden | Session valid, operation disallowed | Permission-denied state |
| revoked/suspended | Session or membership no longer usable | Clear affected cache and explain next action |

## Acceptance tests

Backend/frontend integration is not ready until tests cover anonymous access,
expired/revoked tokens, no membership, wrong organization, every role against
each protected module, cross-resource access, organization switching, and
permission revocation while cached state exists.
