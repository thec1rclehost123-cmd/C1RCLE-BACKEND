/**
 * Planning and ownership metadata for the target /api/v2 surface.
 *
 * Fastify registrations and runtime schemas remain the runtime source of truth.
 * An entry marked PLANNED/BLOCKED/DEFERRED is not a live endpoint. Tests keep
 * ACTIVE entries aligned with the deliberately small registration foundation.
 */

export const API_V2_PREFIX = '/api/v2' as const;

export type V2HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type V2AuthClass =
  'PUBLIC' | 'USER' | 'PARTNER' | 'SCANNER' | 'ADMIN' | 'INTERNAL' | 'WEBHOOK';
export type V2RouteStatus =
  'ACTIVE' | 'WRAPPED' | 'SCAFFOLDED' | 'PLANNED' | 'BLOCKED' | 'DEFERRED';
export type V2IdempotencyRequirement = 'NONE' | 'REQUIRED' | 'PROVIDER_EVENT_ID' | 'TO_BE_DEFINED';
export type V2VersionRequirement = 'NONE' | 'REQUIRED' | 'TO_BE_DEFINED';
export type V2RateLimitClass =
  | 'PUBLIC_READ'
  | 'AUTH_READ'
  | 'STANDARD_COMMAND'
  | 'SENSITIVE_COMMAND'
  | 'PAYMENT_COMMAND'
  | 'SCANNER_COMMAND'
  | 'ADMIN_COMMAND'
  | 'WEBHOOK'
  | 'INTERNAL';
export type V2Pathway =
  | 'PARTNER_BROWSER'
  | 'GUEST_BROWSER'
  | 'MOBILE_NATIVE'
  | 'SCANNER_NATIVE'
  | 'ADMIN_BROWSER'
  | 'PROVIDER'
  | 'WORKER_OR_INTERNAL';

export interface V2RouteDefinition {
  id: string;
  method: V2HttpMethod;
  path: `/api/v2/${string}`;
  domain: string;
  purpose: string;
  consumers: string;
  pathway: V2Pathway;
  invocation: string;
  auth: V2AuthClass;
  authentication: string;
  permission: string;
  scope: string;
  fieldRestrictions: string;
  securityGuardrails: string;
  identifierSecurity: string;
  requestPathParams: string;
  requestQuery: string;
  requestHeaders: string;
  requestBody: string;
  contentType: string;
  maximumPayload: string;
  requestContract: string;
  responseContract: string;
  responseRules: string;
  idempotency: V2IdempotencyRequirement;
  expectedVersion: V2VersionRequirement;
  rateLimit: V2RateLimitClass;
  rateLimitKey: string;
  rateLimitBurst: string;
  rateLimitWindow: string;
  retryPolicy: string;
  audit: string;
  cache: string;
  sourceOfTruth: string;
  currentDataSource: string;
  targetDataSource: string;
  projectionSource: string;
  fallback: string;
  readWrite: 'READ' | 'WRITE/COMMAND';
  transaction: string;
  consistency: string;
  expectedTraffic: string;
  expectedPayload: string;
  expectedDatabaseReads: string;
  pagination: string;
  indexRequirement: string;
  nPlusOneRisk: string;
  providerCostRisk: string;
  backgroundJobCostRisk: string;
  currentEquivalent: string;
  currentOwner: string;
  targetService: string;
  status: V2RouteStatus;
  dependencies: string;
  migrationGate: string;
  deletionCondition: string;
  notes?: string;
}

type RouteOptions = Partial<Omit<V2RouteDefinition, 'id' | 'method' | 'path' | 'domain'>>;

interface DomainDataPolicy {
  sourceOfTruth: string;
  currentDataSource: string;
  targetDataSource: string;
  projectionSource: string;
  fallback: string;
  transaction: string;
  consistency: string;
}

const firestoreDomain = (name: string): DomainDataPolicy => ({
  sourceOfTruth: `${name} domain through its repository interface`,
  currentDataSource: `Legacy Firestore collections listed per current route in API_ROUTE_MIGRATION_MAP.md`,
  targetDataSource: `Firestore repository adapter initially; PostgreSQL only through a separately approved migration`,
  projectionSource: 'None by default; add an owned read projection only with measured need',
  fallback: 'No cross-domain collection fallback; return a stable unavailable/not-found error',
  transaction: 'Repository-managed transaction for writes; none for ordinary reads',
  consistency:
    'Strong for commands and owner reads; explicitly bounded eventual consistency for projections',
});

const DOMAIN_DATA_POLICIES: Record<string, DomainDataPolicy> = {
  internal: {
    sourceOfTruth: 'Current API process and initialized adapter state',
    currentDataSource: 'Fastify process metadata and registered plugin state',
    targetDataSource: 'No durable database',
    projectionSource: 'None',
    fallback: 'Fail readiness closed without querying business data',
    transaction: 'None',
    consistency: 'Immediate process-local state',
  },
  session: {
    sourceOfTruth: 'Firebase Authentication identity plus server-owned session policy',
    currentDataSource: 'Firebase Authentication and existing Firestore user/membership records',
    targetDataSource: 'Canonical identity adapter plus session application service',
    projectionSource: 'Bounded server-side membership/session projection only',
    fallback: 'Deny when identity or required membership cannot be verified',
    transaction: 'Repository transaction for session/membership writes',
    consistency: 'Revocation-aware identity; strong authorization checks',
  },
  organizations: firestoreDomain('Organizations and permissions'),
  venues: firestoreDomain('Venue'),
  events: firestoreDomain('Event'),
  'event-catalog': firestoreDomain('Event catalog'),
  guests: firestoreDomain('Guests and guest lists'),
  audiences: firestoreDomain('Audience'),
  promoters: firestoreDomain('Promoter and commission'),
  staff: firestoreDomain('Staff and permissions'),
  campaigns: firestoreDomain('Campaign'),
  notifications: firestoreDomain('Notification'),
  social: firestoreDomain('Social and chat'),
  public: {
    sourceOfTruth: 'Owning canonical domain; public projections are read models, never authority',
    currentDataSource:
      'Firestore public-discovery/event/venue projections and legacy canonical fallback paths',
    targetDataSource:
      'Small Firestore public projection behind a repository; search only resolves discoverability',
    projectionSource: 'Background-built public discovery projection',
    fallback: 'Canonical repository lookup only where explicit public-field policy permits',
    transaction: 'None',
    consistency: 'Bounded eventual consistency with publication/version metadata',
  },
  checkout: {
    sourceOfTruth: 'Order and Inventory domains',
    currentDataSource: 'Firestore order/inventory records; Redis short-lived locks',
    targetDataSource: 'PostgreSQL transaction after the dedicated commerce migration stage',
    projectionSource: 'None for command authority',
    fallback: 'Fail closed; never reconstruct price or inventory authority from cache/client data',
    transaction: 'Required across authoritative order/inventory writes',
    consistency: 'Strong; serialized inventory decision',
  },
  orders: {
    ...firestoreDomain('Order'),
    targetDataSource:
      'PostgreSQL transactional repository after the dedicated commerce migration stage',
    transaction:
      'Required for order mutations; read-only queries use the owned repository/projection',
  },
  payments: {
    sourceOfTruth: 'Internal payment record reconciled with signed provider evidence',
    currentDataSource: 'Firestore payment/order records plus Razorpay provider API/callbacks',
    targetDataSource:
      'PostgreSQL payment ledger after dedicated migration; provider behind an interface',
    projectionSource: 'Read-only payment status projection',
    fallback: 'Pending/unknown; never accept client-declared payment success',
    transaction: 'Required for finalization and webhook receipt uniqueness',
    consistency: 'Strong finalization with idempotent provider reconciliation',
  },
  tickets: {
    ...firestoreDomain('Ticket entitlement'),
    targetDataSource:
      'PostgreSQL entitlement repository after dedicated migration; signed credentials are proofs, not truth',
    transaction: 'Required for issue, transfer, claim and revocation',
  },
  wallet: {
    ...firestoreDomain('Ticket entitlement'),
    sourceOfTruth: 'Ticket entitlement and Order domains',
    projectionSource: 'User wallet read projection',
  },
  refunds: {
    ...firestoreDomain('Refund and ledger'),
    targetDataSource:
      'PostgreSQL transaction and ledger after dedicated migration; provider behind an interface',
    transaction: 'Required with immutable ledger/outbox writes',
  },
  door: {
    ...firestoreDomain('Door and ticket entitlement'),
    sourceOfTruth: 'Ticket entitlement plus Door check-in state',
    projectionSource: 'Signed, expiring offline manifest; never durable truth',
    transaction: 'Required for check-in uniqueness and override audit',
    consistency: 'Strong online; bounded conflict-aware reconciliation for offline scans',
  },
  finance: {
    ...firestoreDomain('Ledger'),
    sourceOfTruth: 'Immutable ledger entries, not cached summaries',
    targetDataSource: 'PostgreSQL ledger after dedicated finance migration',
    projectionSource: 'Precomputed finance summaries',
  },
  payouts: {
    ...firestoreDomain('Payout and ledger'),
    targetDataSource:
      'PostgreSQL payout/ledger transaction after dedicated migration; provider adapter',
    transaction: 'Required with immutable audit and outbox records',
  },
  analytics: {
    sourceOfTruth: 'Owning business domains; analytics is never command authority',
    currentDataSource: 'Firestore records and existing aggregate services',
    targetDataSource: 'Background-built analytics projection',
    projectionSource: 'Owned aggregate/read-model store',
    fallback: 'Return unavailable/partial metadata; do not fan out across canonical collections',
    transaction: 'None',
    consistency: 'Eventual with an explicit generated-at watermark',
  },
  admin: firestoreDomain('Platform administration'),
};

const RATE_LIMIT_POLICIES: Record<
  V2RateLimitClass,
  Pick<V2RouteDefinition, 'rateLimitKey' | 'rateLimitBurst' | 'rateLimitWindow' | 'retryPolicy'>
> = {
  PUBLIC_READ: {
    rateLimitKey: 'IP + device fingerprint',
    rateLimitBurst: '120',
    rateLimitWindow: '1 minute',
    retryPolicy: '429 with Retry-After; cache and bot controls first',
  },
  AUTH_READ: {
    rateLimitKey: 'User + organization when scoped',
    rateLimitBurst: '120',
    rateLimitWindow: '1 minute',
    retryPolicy: '429 with Retry-After; bounded jittered retry for safe reads',
  },
  STANDARD_COMMAND: {
    rateLimitKey: 'User + organization',
    rateLimitBurst: '30',
    rateLimitWindow: '1 minute',
    retryPolicy: '429 with Retry-After; retry only with the same idempotency key',
  },
  SENSITIVE_COMMAND: {
    rateLimitKey: 'User + organization + resource',
    rateLimitBurst: '10',
    rateLimitWindow: '1 minute',
    retryPolicy: '429 with Retry-After; no automatic client retry',
  },
  PAYMENT_COMMAND: {
    rateLimitKey: 'User + device + IP + order',
    rateLimitBurst: '8',
    rateLimitWindow: '1 minute',
    retryPolicy: '429 with Retry-After; no aggressive or status-changing retry',
  },
  SCANNER_COMMAND: {
    rateLimitKey: 'Device + door session + event + operator',
    rateLimitBurst: '300',
    rateLimitWindow: '1 minute',
    retryPolicy: '429 with Retry-After; preserve offline queue and reject credential abuse',
  },
  ADMIN_COMMAND: {
    rateLimitKey: 'Admin user + operation',
    rateLimitBurst: '10',
    rateLimitWindow: '1 minute',
    retryPolicy: '429 with Retry-After; step-up auth for sensitive operations',
  },
  WEBHOOK: {
    rateLimitKey: 'Provider + account + event ID',
    rateLimitBurst: '300',
    rateLimitWindow: '1 minute',
    retryPolicy: '429 with Retry-After; preserve legitimate signed provider retries',
  },
  INTERNAL: {
    rateLimitKey: 'Service identity + network source',
    rateLimitBurst: '600',
    rateLimitWindow: '1 minute',
    retryPolicy: '429 with Retry-After; approved callers only',
  },
};

function deriveRateLimit(method: V2HttpMethod, path: string, auth: V2AuthClass): V2RateLimitClass {
  if (auth === 'WEBHOOK') return 'WEBHOOK';
  if (auth === 'INTERNAL' || path.includes('/internal/')) return 'INTERNAL';
  if (auth === 'ADMIN') return 'ADMIN_COMMAND';
  if (auth === 'SCANNER' || path.includes('/door/')) return 'SCANNER_COMMAND';
  if (/\/checkout\/|\/payments\//.test(path)) return 'PAYMENT_COMMAND';
  if (method === 'GET') return auth === 'PUBLIC' ? 'PUBLIC_READ' : 'AUTH_READ';
  if (/publish|cancel|refund|transfer|claim|override|send|payout|bank-account/.test(path))
    return 'SENSITIVE_COMMAND';
  return 'STANDARD_COMMAND';
}

function derivePathway(auth: V2AuthClass, domain: string): V2Pathway {
  if (auth === 'WEBHOOK') return 'PROVIDER';
  if (auth === 'INTERNAL') return 'WORKER_OR_INTERNAL';
  if (auth === 'ADMIN') return 'ADMIN_BROWSER';
  if (auth === 'SCANNER' || domain === 'door') return 'SCANNER_NATIVE';
  if (auth === 'PUBLIC') return 'GUEST_BROWSER';
  if (auth === 'PARTNER') return 'PARTNER_BROWSER';
  return 'MOBILE_NATIVE';
}

function deriveIdentifierSecurity(path: string): string {
  if (path.includes(':slug') || path.includes(':idOrSlug'))
    return 'Validated public slug or opaque ID; slug is not an authorization boundary';
  if (path.includes('/webhooks/'))
    return 'Provider identifier allowlist plus signed raw payload and hashed replay key';
  if (path.includes('/door/offline'))
    return 'Opaque IDs plus versioned, signed, expiring scanner credential/manifest';
  if (/transfer|claim|invitation/.test(path))
    return 'Opaque resource ID; raw one-time token accepted only in body and stored as a hash';
  return path.includes(':')
    ? 'Opaque non-sequential resource IDs with backend ownership checks'
    : 'Normal authenticated or public path; no security-through-obscurity';
}

function pathParameters(path: string): string {
  const params = [...path.matchAll(/:([A-Za-z0-9]+)/g)].map((match) => match[1]);
  return params.length
    ? `${params.join(', ')}: validated opaque ID or validated slug as named`
    : 'None';
}

function defineRoute(
  id: string,
  method: V2HttpMethod,
  path: V2RouteDefinition['path'],
  domain: string,
  options: RouteOptions = {},
): V2RouteDefinition {
  const isRead = method === 'GET';
  const auth = options.auth || 'PARTNER';
  const rateLimit = options.rateLimit || deriveRateLimit(method, path, auth);
  const pathway = options.pathway || derivePathway(auth, domain);
  const dataPolicy = DOMAIN_DATA_POLICIES[domain] || firestoreDomain(domain);
  const ratePolicy = RATE_LIMIT_POLICIES[rateLimit];
  const isWebhook = auth === 'WEBHOOK';
  const isOrganizationScoped = path.includes(':organizationId');
  const result: V2RouteDefinition = {
    id,
    method,
    path,
    domain,
    purpose: `${isRead ? 'Read' : 'Execute'} the ${id} use case through the ${domain} module`,
    consumers: 'To be confirmed from current client and runtime evidence',
    pathway,
    invocation:
      pathway === 'PROVIDER'
        ? 'Provider direct to dedicated Gateway webhook'
        : pathway === 'WORKER_OR_INTERNAL'
          ? 'Authenticated internal caller or infrastructure probe direct to Gateway'
          : 'Typed/generated client direct to Gateway; thin Next.js transport only when server-only or cookie transport is required',
    auth,
    authentication:
      auth === 'PUBLIC'
        ? 'No user token; public-field policy still applies'
        : auth === 'WEBHOOK'
          ? 'Provider raw-body signature and account/environment binding'
          : auth === 'INTERNAL'
            ? 'Service identity and approved network/token policy'
            : 'Canonical backend Firebase ID-token verification; revoked/disabled checks where required',
    permission: 'To be finalized in the authorization stage',
    scope: 'Resource ownership/scope to be finalized before activation',
    fieldRestrictions:
      'Allowlisted DTO fields only; never expose internal audit, provider, secret or database fields',
    securityGuardrails:
      'Strict runtime validation, default deny, IDOR and mass-assignment protection, bounded input, redacted logs',
    identifierSecurity: deriveIdentifierSecurity(path),
    requestPathParams: pathParameters(path),
    requestQuery: isRead
      ? 'Strict typed query; cursor pagination and bounded page size when collection-shaped'
      : 'None unless explicitly defined by the route contract',
    requestHeaders: `${auth === 'PUBLIC' ? '' : auth === 'WEBHOOK' ? 'Provider signature, provider event ID, ' : 'Authorization: Bearer token, '}${isOrganizationScoped ? 'X-Organization-Id (must match authorized path scope), ' : ''}X-Request-Id${!isRead && !isWebhook ? ', Idempotency-Key when required, If-Match when versioned' : ''}`,
    requestBody: isRead
      ? 'None'
      : isWebhook
        ? 'Raw provider payload; adapter validates and maps it'
        : 'Strict use-case command DTO; identity, ownership, totals and permissions are server-derived',
    contentType: isRead
      ? 'No request body'
      : 'application/json; provider media type only for a proven webhook protocol',
    maximumPayload: isRead
      ? 'No body; query string <= 8 KiB'
      : isWebhook
        ? '1 MiB pending provider-specific proof'
        : '64 KiB by default; smaller route-specific limit preferred',
    requestContract: isRead
      ? 'Planned shared params/query contract'
      : 'Planned shared command contract',
    responseContract: 'Planned shared response contract',
    responseRules:
      'Strict DTO in { data, meta }; nullable fields explicit; no raw database/provider objects; stable error envelope with requestId',
    idempotency: isRead ? 'NONE' : 'TO_BE_DEFINED',
    expectedVersion: isRead ? 'NONE' : 'TO_BE_DEFINED',
    rateLimit,
    ...ratePolicy,
    audit: isRead ? 'NONE' : 'BUSINESS_COMMAND',
    cache: isRead ? 'PRIVATE_SHORT' : 'NO_STORE',
    ...dataPolicy,
    readWrite: isRead ? 'READ' : 'WRITE/COMMAND',
    expectedTraffic:
      auth === 'PUBLIC'
        ? 'High/variable public traffic'
        : domain === 'door'
          ? 'High short event-time bursts'
          : 'Moderate authenticated traffic; validate with production telemetry',
    expectedPayload: isRead
      ? 'Small DTO; collection routes paginated'
      : 'Small command DTO; exports/media require separate signed-URL routes',
    expectedDatabaseReads: isRead
      ? 'Bounded repository query; budget and measure before activation'
      : 'Bounded precondition reads plus transactional writes',
    pagination: isRead
      ? 'Cursor pagination for collection routes; maximum page size required'
      : 'Not applicable',
    indexRequirement: isRead
      ? 'Prove required index from final query shape before activation'
      : 'No new index in this stage',
    nPlusOneRisk: isRead
      ? 'Must be eliminated with projection, batch or multi-get before activation'
      : 'No unbounded per-item repository calls',
    providerCostRisk: /payment|payout|campaign|notification/.test(domain)
      ? 'Provider calls must be measured, deduplicated and never used as an unbounded read fan-out'
      : 'None expected unless the approved use case adds a provider adapter',
    backgroundJobCostRisk: /public|analytics|campaign|notification|finance/.test(domain)
      ? 'Projection/job fan-out must be bounded, idempotent and observable'
      : 'None expected by default',
    currentEquivalent: 'Current-route mapping requires workflow proof',
    currentOwner: 'Current owner documented in API_ROUTE_MIGRATION_MAP.md',
    targetService: `${domain} application service`,
    status: 'PLANNED',
    dependencies:
      'Approved contract, application interface, repository/provider ports, policy and focused tests',
    migrationGate:
      'Current behavior and consumers proven; contract/security/performance tests pass; rollback remains independent',
    deletionCondition:
      'All consumers migrated; runtime traffic proves zero legacy use; provider/job/mobile compatibility cleared; rollback does not depend on legacy route',
    ...options,
  };
  return result;
}

const publicRead = (
  id: string,
  path: V2RouteDefinition['path'],
  domain: string,
  options: RouteOptions = {},
) =>
  defineRoute(id, 'GET', path, domain, {
    consumers: 'Guest Portal, Mobile App, SEO; verify additional consumers',
    auth: 'PUBLIC',
    permission: 'None; public-field policy required',
    scope: 'Published public projection only',
    rateLimit: 'PUBLIC_READ',
    cache: 'PUBLIC_CDN',
    ...options,
  });

const webhook = (
  id: string,
  path: V2RouteDefinition['path'],
  domain: string,
  options: RouteOptions = {},
) =>
  defineRoute(id, 'POST', path, domain, {
    consumers: 'External provider; deployed callback configuration is unverified',
    auth: 'WEBHOOK',
    permission: 'Verified provider signature',
    scope: 'Provider account/environment',
    requestContract: 'Raw signed provider payload plus provider-specific adapter',
    idempotency: 'PROVIDER_EVENT_ID',
    expectedVersion: 'NONE',
    rateLimit: 'WEBHOOK',
    audit: 'PROVIDER_EVENT',
    cache: 'NO_STORE',
    status: 'BLOCKED',
    notes: 'Not registered until callback ownership, signature and finalizer behavior are proven.',
    ...options,
  });

export const API_V2_ROUTES: readonly V2RouteDefinition[] = [
  defineRoute('internal.health', 'GET', '/api/v2/internal/health', 'internal', {
    consumers: 'Load balancer and operators',
    pathway: 'WORKER_OR_INTERNAL',
    invocation: 'Infrastructure probe direct to Fastify API Gateway',
    auth: 'PUBLIC',
    permission: 'None; liveness only',
    scope: 'Current API process',
    requestContract: 'None',
    responseContract: 'V2InternalHealthResponse',
    idempotency: 'NONE',
    expectedVersion: 'NONE',
    rateLimit: 'INTERNAL',
    rateLimitKey:
      'Credential fingerprint when present, otherwise caller IP (current Gateway limiter)',
    audit: 'NONE',
    cache: 'NO_STORE',
    expectedTraffic: 'Low, regular infrastructure probe traffic',
    expectedDatabaseReads: 'Zero',
    pagination: 'Not applicable',
    indexRequirement: 'None',
    nPlusOneRisk: 'None',
    currentEquivalent: 'GET /health and GET /api/v1/health remain unchanged',
    currentOwner: 'apps/api-gateway/src/app.ts',
    targetService: 'API liveness adapter',
    status: 'ACTIVE',
  }),
  defineRoute('internal.version', 'GET', '/api/v2/internal/version', 'internal', {
    consumers: 'Operators, smoke tests and support tooling',
    pathway: 'WORKER_OR_INTERNAL',
    invocation: 'Infrastructure/support probe direct to Fastify API Gateway',
    auth: 'PUBLIC',
    permission: 'None; non-secret build metadata only',
    scope: 'Current API deployment',
    requestContract: 'None',
    responseContract: 'V2InternalVersionResponse',
    idempotency: 'NONE',
    expectedVersion: 'NONE',
    rateLimit: 'INTERNAL',
    rateLimitKey:
      'Credential fingerprint when present, otherwise caller IP (current Gateway limiter)',
    audit: 'NONE',
    cache: 'NO_STORE',
    expectedTraffic: 'Low operator and smoke-test traffic',
    expectedDatabaseReads: 'Zero',
    pagination: 'Not applicable',
    indexRequirement: 'None',
    nPlusOneRisk: 'None',
    currentEquivalent: 'No dedicated current route found',
    currentOwner: 'None',
    targetService: 'API build metadata adapter',
    status: 'ACTIVE',
  }),
  defineRoute('internal.readiness', 'GET', '/api/v2/internal/readiness', 'internal', {
    consumers: 'Load balancer and operators',
    pathway: 'WORKER_OR_INTERNAL',
    invocation: 'Infrastructure readiness probe direct to Fastify API Gateway',
    auth: 'PUBLIC',
    permission: 'None; aggregate adapter readiness only',
    scope:
      'Current Gateway process; deployment should restrict this path to infrastructure callers',
    requestContract: 'None',
    responseContract: 'V2InternalReadinessResponse',
    responseRules:
      'Strict aggregate readiness DTO; no environment values, credentials, project IDs or provider details',
    currentEquivalent: 'GET /health currently mixes liveness and dependency checks',
    currentOwner: 'apps/api-gateway/src/app.ts',
    targetService: 'Readiness probe adapter',
    rateLimit: 'INTERNAL',
    rateLimitKey:
      'Credential fingerprint when present, otherwise caller IP (current Gateway limiter)',
    cache: 'NO_STORE',
    expectedTraffic: 'Low, regular infrastructure probe traffic',
    expectedDatabaseReads: 'Zero; adapter registration/status checks only',
    pagination: 'Not applicable',
    indexRequirement: 'None',
    nPlusOneRisk: 'None',
    status: 'ACTIVE',
    notes:
      'Checks initialized adapter state without database/provider traffic; 503 unless required adapters are ready.',
  }),
  defineRoute('internal.jobs.list', 'GET', '/api/v2/internal/jobs', 'internal', {
    auth: 'INTERNAL',
    status: 'DEFERRED',
  }),
  defineRoute('internal.reconciliation', 'POST', '/api/v2/internal/reconciliation', 'internal', {
    auth: 'INTERNAL',
    status: 'BLOCKED',
    idempotency: 'REQUIRED',
  }),
  defineRoute('internal.projections', 'POST', '/api/v2/internal/projections', 'internal', {
    auth: 'INTERNAL',
    status: 'BLOCKED',
    idempotency: 'REQUIRED',
  }),

  defineRoute('session.get', 'GET', '/api/v2/session', 'session', {
    consumers: 'All authenticated clients',
    auth: 'USER',
    permission: 'Authenticated identity',
    scope: 'Self',
    currentEquivalent: 'Current auth/profile/session routes; exact authority unresolved',
    status: 'DEFERRED',
  }),
  defineRoute('session.sync', 'POST', '/api/v2/session/sync', 'session', {
    consumers: 'All clients after Firebase sign-in',
    auth: 'USER',
    permission: 'Verified Firebase identity',
    scope: 'Self',
    idempotency: 'REQUIRED',
    currentEquivalent: 'POST /api/v1/auth/sync and related client flows require fresh verification',
    status: 'DEFERRED',
  }),
  defineRoute('session.logout', 'POST', '/api/v2/session/logout', 'session', {
    consumers: 'All authenticated clients',
    auth: 'USER',
    permission: 'Authenticated identity',
    scope: 'Self',
    idempotency: 'REQUIRED',
    status: 'DEFERRED',
  }),

  defineRoute('organizations.list', 'GET', '/api/v2/organizations', 'organizations', {
    consumers: 'Partner Dashboard, Admin Console',
    permission: 'organization.read',
    scope: 'Active memberships',
  }),
  defineRoute('organizations.create', 'POST', '/api/v2/organizations', 'organizations', {
    consumers: 'Partner Dashboard',
    permission: 'organization.create',
    scope: 'Authenticated user',
    idempotency: 'REQUIRED',
  }),
  defineRoute(
    'organizations.get',
    'GET',
    '/api/v2/organizations/:organizationId',
    'organizations',
    { permission: 'organization.read', scope: 'Organization membership' },
  ),
  defineRoute(
    'organizations.update',
    'PATCH',
    '/api/v2/organizations/:organizationId',
    'organizations',
    {
      permission: 'organization.manage',
      scope: 'Organization membership and version',
      expectedVersion: 'REQUIRED',
      idempotency: 'REQUIRED',
    },
  ),
  defineRoute(
    'organization-members.list',
    'GET',
    '/api/v2/organizations/:organizationId/members',
    'organizations',
    { permission: 'staff.read', scope: 'Organization membership' },
  ),
  defineRoute(
    'organization-members.invite',
    'POST',
    '/api/v2/organizations/:organizationId/members',
    'organizations',
    { permission: 'staff.manage', scope: 'Organization membership', idempotency: 'REQUIRED' },
  ),
  defineRoute(
    'organization-invitations.list',
    'GET',
    '/api/v2/organizations/:organizationId/invitations',
    'organizations',
    { permission: 'staff.read', scope: 'Organization membership' },
  ),
  defineRoute(
    'organization-invitations.create',
    'POST',
    '/api/v2/organizations/:organizationId/invitations',
    'organizations',
    { permission: 'staff.manage', scope: 'Organization membership', idempotency: 'REQUIRED' },
  ),

  defineRoute('venues.list', 'GET', '/api/v2/organizations/:organizationId/venues', 'venues', {
    permission: 'venue.read',
    scope: 'Organization membership',
  }),
  defineRoute('venues.create', 'POST', '/api/v2/organizations/:organizationId/venues', 'venues', {
    permission: 'venue.manage',
    scope: 'Organization membership',
    idempotency: 'REQUIRED',
  }),
  defineRoute('venues.get', 'GET', '/api/v2/venues/:venueId', 'venues', {
    permission: 'venue.read',
    scope: 'Venue organization',
  }),
  defineRoute('venues.update', 'PATCH', '/api/v2/venues/:venueId', 'venues', {
    permission: 'venue.manage',
    scope: 'Venue organization and version',
    idempotency: 'REQUIRED',
    expectedVersion: 'REQUIRED',
  }),
  defineRoute('venue-profile.get', 'GET', '/api/v2/venues/:venueId/profile', 'venues', {
    permission: 'venue.read',
    scope: 'Venue organization',
  }),
  defineRoute('venue-profile.update', 'PATCH', '/api/v2/venues/:venueId/profile', 'venues', {
    permission: 'venue.manage',
    scope: 'Venue organization and version',
    idempotency: 'REQUIRED',
    expectedVersion: 'REQUIRED',
  }),
  defineRoute('venue-calendar.get', 'GET', '/api/v2/venues/:venueId/calendar', 'venues', {
    permission: 'venue.read',
    scope: 'Venue organization',
  }),
  defineRoute('venue-menu.get', 'GET', '/api/v2/venues/:venueId/menu', 'venues', {
    permission: 'venue.read',
    scope: 'Venue organization',
  }),
  defineRoute('venue-menu.update', 'PUT', '/api/v2/venues/:venueId/menu', 'venues', {
    permission: 'venue.manage',
    scope: 'Venue organization and version',
    idempotency: 'REQUIRED',
    expectedVersion: 'REQUIRED',
  }),
  defineRoute('venue-availability.get', 'GET', '/api/v2/venues/:venueId/availability', 'venues', {
    permission: 'venue.read',
    scope: 'Venue organization',
  }),
  defineRoute(
    'venue-slot-requests.list',
    'GET',
    '/api/v2/venues/:venueId/slot-requests',
    'venues',
    { permission: 'venue.read', scope: 'Venue organization' },
  ),
  defineRoute(
    'venue-slot-requests.create',
    'POST',
    '/api/v2/venues/:venueId/slot-requests',
    'venues',
    { permission: 'event.create', scope: 'Venue/host relationship', idempotency: 'REQUIRED' },
  ),

  defineRoute('events.list', 'GET', '/api/v2/organizations/:organizationId/events', 'events', {
    permission: 'event.read',
    scope: 'Organization membership',
  }),
  defineRoute('events.create', 'POST', '/api/v2/organizations/:organizationId/events', 'events', {
    permission: 'event.create',
    scope: 'Organization membership',
    idempotency: 'REQUIRED',
  }),
  defineRoute('events.get', 'GET', '/api/v2/events/:eventId', 'events', {
    permission: 'event.read',
    scope: 'Event organization/assignment',
  }),
  defineRoute('events.update', 'PATCH', '/api/v2/events/:eventId', 'events', {
    permission: 'event.update',
    scope: 'Event organization and version',
    idempotency: 'REQUIRED',
    expectedVersion: 'REQUIRED',
  }),
  ...(['review', 'publish', 'pause-sales', 'resume-sales', 'cancel', 'duplicate'] as const).map(
    (action) =>
      defineRoute(`events.${action}`, 'POST', `/api/v2/events/:eventId/${action}`, 'events', {
        permission: `event.${action}`,
        scope: 'Event organization and state',
        idempotency: 'REQUIRED',
        expectedVersion: 'REQUIRED',
      }),
  ),
  defineRoute('event-previews.get', 'GET', '/api/v2/events/:eventId/previews', 'events', {
    permission: 'event.read',
    scope: 'Event organization',
  }),
  ...(['ticket-tiers', 'promo-codes', 'table-packages', 'promoter-assignments'] as const).flatMap(
    (resource) => [
      defineRoute(
        `event-${resource}.list`,
        'GET',
        `/api/v2/events/:eventId/${resource}`,
        'event-catalog',
        { permission: 'event.read', scope: 'Event organization' },
      ),
      defineRoute(
        `event-${resource}.create`,
        'POST',
        `/api/v2/events/:eventId/${resource}`,
        'event-catalog',
        {
          permission: 'event.update',
          scope: 'Event organization and version',
          idempotency: 'REQUIRED',
          expectedVersion: 'REQUIRED',
        },
      ),
    ],
  ),

  publicRead('public.events.list', '/api/v2/public/events', 'public'),
  publicRead('public.events.get', '/api/v2/public/events/:idOrSlug', 'public'),
  publicRead('public.venues.get', '/api/v2/public/venues/:slug', 'public'),
  publicRead('public.hosts.get', '/api/v2/public/hosts/:slug', 'public'),
  publicRead('public.promoters.get', '/api/v2/public/promoters/:slug', 'public'),
  publicRead('public.discovery', '/api/v2/public/discovery', 'public'),
  publicRead('public.search', '/api/v2/public/search', 'public'),

  defineRoute('checkout.quote', 'POST', '/api/v2/checkout/quote', 'checkout', {
    consumers: 'Guest Portal and Mobile App',
    auth: 'USER',
    permission: 'checkout.create',
    scope: 'Self and published event',
    idempotency: 'REQUIRED',
    status: 'BLOCKED',
  }),
  defineRoute('checkout.holds', 'POST', '/api/v2/checkout/holds', 'checkout', {
    consumers: 'Guest Portal and Mobile App',
    auth: 'USER',
    permission: 'checkout.create',
    scope: 'Self and published event inventory',
    idempotency: 'REQUIRED',
    status: 'BLOCKED',
  }),
  defineRoute('orders.list', 'GET', '/api/v2/orders', 'orders', {
    consumers: 'Guest, Mobile, Partner and Admin subject to scope',
    auth: 'USER',
    permission: 'order.read',
    scope: 'Self or authorized organization',
  }),
  defineRoute('orders.create', 'POST', '/api/v2/orders', 'orders', {
    consumers: 'Guest Portal and Mobile App',
    auth: 'USER',
    permission: 'checkout.create',
    scope: 'Self and active hold',
    idempotency: 'REQUIRED',
    status: 'BLOCKED',
  }),
  defineRoute('orders.get', 'GET', '/api/v2/orders/:orderId', 'orders', {
    auth: 'USER',
    permission: 'order.read',
    scope: 'Buyer or authorized organization',
  }),
  defineRoute('orders.status', 'GET', '/api/v2/orders/:orderId/status', 'orders', {
    auth: 'USER',
    permission: 'order.read',
    scope: 'Buyer or authorized organization',
    cache: 'NO_STORE',
  }),
  defineRoute('orders.cancel', 'POST', '/api/v2/orders/:orderId/cancel', 'orders', {
    auth: 'USER',
    permission: 'order.cancel',
    scope: 'Buyer or authorized organization and order state',
    idempotency: 'REQUIRED',
    expectedVersion: 'REQUIRED',
    status: 'BLOCKED',
  }),

  defineRoute('payments.attempts', 'POST', '/api/v2/payments/attempts', 'payments', {
    consumers: 'Guest Portal and Mobile App',
    auth: 'USER',
    permission: 'payment.create',
    scope: 'Buyer and order',
    idempotency: 'REQUIRED',
    status: 'BLOCKED',
  }),
  defineRoute('payments.get', 'GET', '/api/v2/payments/:paymentId', 'payments', {
    auth: 'USER',
    permission: 'payment.read',
    scope: 'Buyer or authorized finance scope',
    cache: 'NO_STORE',
    status: 'BLOCKED',
  }),
  defineRoute('payments.verify', 'POST', '/api/v2/payments/:paymentId/verify', 'payments', {
    auth: 'USER',
    permission: 'payment.verify',
    scope: 'Buyer and payment',
    idempotency: 'REQUIRED',
    status: 'BLOCKED',
  }),
  webhook('webhooks.payments', '/api/v2/webhooks/payments/:provider', 'payments'),

  defineRoute('tickets.get', 'GET', '/api/v2/tickets/:ticketId', 'tickets', {
    consumers: 'Guest, Mobile, Partner, Scanner and Admin subject to scope',
    auth: 'USER',
    permission: 'ticket.read',
    scope: 'Owner or authorized operational scope',
    cache: 'NO_STORE',
    status: 'BLOCKED',
  }),
  ...(['transfer', 'claim', 'cancel-transfer'] as const).map((action) =>
    defineRoute(`tickets.${action}`, 'POST', `/api/v2/tickets/:ticketId/${action}`, 'tickets', {
      consumers: 'Guest Portal and Mobile App',
      auth: 'USER',
      permission: `ticket.${action}`,
      scope: 'Ticket owner/claim policy',
      idempotency: 'REQUIRED',
      expectedVersion: 'REQUIRED',
      status: 'BLOCKED',
    }),
  ),
  defineRoute('wallet.get', 'GET', '/api/v2/wallet', 'wallet', {
    consumers: 'Guest Portal and Mobile App',
    auth: 'USER',
    permission: 'wallet.read',
    scope: 'Self',
    cache: 'NO_STORE',
    status: 'BLOCKED',
  }),
  defineRoute('wallet.tickets', 'GET', '/api/v2/wallet/tickets', 'wallet', {
    consumers: 'Guest Portal and Mobile App',
    auth: 'USER',
    permission: 'wallet.read',
    scope: 'Self',
    cache: 'NO_STORE',
    status: 'BLOCKED',
  }),
  defineRoute('wallet.orders', 'GET', '/api/v2/wallet/orders', 'wallet', {
    consumers: 'Guest Portal and Mobile App',
    auth: 'USER',
    permission: 'wallet.read',
    scope: 'Self',
    cache: 'NO_STORE',
    status: 'BLOCKED',
  }),

  defineRoute('order-refunds.list', 'GET', '/api/v2/orders/:orderId/refunds', 'refunds', {
    auth: 'USER',
    permission: 'refund.read',
    scope: 'Buyer or authorized organization',
    cache: 'NO_STORE',
    status: 'BLOCKED',
  }),
  defineRoute('order-refunds.create', 'POST', '/api/v2/orders/:orderId/refunds', 'refunds', {
    auth: 'USER',
    permission: 'refund.create',
    scope: 'Buyer or authorized organization and order',
    idempotency: 'REQUIRED',
    status: 'BLOCKED',
  }),
  defineRoute('refunds.get', 'GET', '/api/v2/refunds/:refundId', 'refunds', {
    auth: 'USER',
    permission: 'refund.read',
    scope: 'Buyer or authorized organization',
    cache: 'NO_STORE',
    status: 'BLOCKED',
  }),
  ...(['approve', 'reject'] as const).map((action) =>
    defineRoute(`refunds.${action}`, 'POST', `/api/v2/refunds/:refundId/${action}`, 'refunds', {
      permission: `refund.${action}`,
      scope: 'Authorized organization/platform and refund state',
      idempotency: 'REQUIRED',
      expectedVersion: 'REQUIRED',
      status: 'BLOCKED',
    }),
  ),

  defineRoute(
    'organization-guests.list',
    'GET',
    '/api/v2/organizations/:organizationId/guests',
    'guests',
    { permission: 'guest.read', scope: 'Organization and field-level PII policy' },
  ),
  defineRoute('event-guests.list', 'GET', '/api/v2/events/:eventId/guests', 'guests', {
    permission: 'guest.read',
    scope: 'Event organization/assignment and PII policy',
  }),
  defineRoute('event-guest-lists.list', 'GET', '/api/v2/events/:eventId/guest-lists', 'guests', {
    permission: 'guest.read',
    scope: 'Event organization',
  }),
  defineRoute('event-guest-lists.create', 'POST', '/api/v2/events/:eventId/guest-lists', 'guests', {
    permission: 'guest.manage',
    scope: 'Event organization',
    idempotency: 'REQUIRED',
  }),
  defineRoute(
    'guest-list-entries.list',
    'GET',
    '/api/v2/guest-lists/:guestListId/entries',
    'guests',
    { permission: 'guest.read', scope: 'Guest-list event organization' },
  ),
  defineRoute(
    'guest-list-entries.create',
    'POST',
    '/api/v2/guest-lists/:guestListId/entries',
    'guests',
    { permission: 'guest.manage', scope: 'Guest-list event organization', idempotency: 'REQUIRED' },
  ),
  defineRoute('audiences.list', 'GET', '/api/v2/audiences', 'audiences', {
    permission: 'campaign.read',
    scope: 'Active organization',
  }),
  defineRoute('audiences.create', 'POST', '/api/v2/audiences', 'audiences', {
    permission: 'campaign.create',
    scope: 'Active organization and consent policy',
    idempotency: 'REQUIRED',
  }),
  defineRoute('audiences.get', 'GET', '/api/v2/audiences/:audienceId', 'audiences', {
    permission: 'campaign.read',
    scope: 'Audience organization',
  }),

  defineRoute('promoters.get', 'GET', '/api/v2/promoters/:promoterId', 'promoters', {
    permission: 'promoter.read',
    scope: 'Self, assignment or organization relationship',
  }),
  defineRoute(
    'promoter-assignments.get',
    'GET',
    '/api/v2/promoter-assignments/:assignmentId',
    'promoters',
    { permission: 'promoter.read', scope: 'Assignment participant' },
  ),
  ...(['accept', 'reject'] as const).map((action) =>
    defineRoute(
      `promoter-assignments.${action}`,
      'POST',
      `/api/v2/promoter-assignments/:assignmentId/${action}`,
      'promoters',
      {
        permission: `promoter-assignment.${action}`,
        scope: 'Assigned promoter and assignment state',
        idempotency: 'REQUIRED',
        expectedVersion: 'REQUIRED',
      },
    ),
  ),
  defineRoute(
    'promoter-assignment-links.list',
    'GET',
    '/api/v2/promoter-assignments/:assignmentId/referral-links',
    'promoters',
    { permission: 'promoter.read', scope: 'Assignment participant' },
  ),
  defineRoute(
    'promoter-assignment-links.create',
    'POST',
    '/api/v2/promoter-assignments/:assignmentId/referral-links',
    'promoters',
    {
      permission: 'promoter.manage-links',
      scope: 'Assignment participant',
      idempotency: 'REQUIRED',
    },
  ),
  defineRoute(
    'promoter-assignment-performance',
    'GET',
    '/api/v2/promoter-assignments/:assignmentId/performance',
    'promoters',
    { permission: 'promoter.analytics', scope: 'Assignment participant' },
  ),

  defineRoute(
    'organization-staff.list',
    'GET',
    '/api/v2/organizations/:organizationId/staff',
    'staff',
    { permission: 'staff.read', scope: 'Organization membership' },
  ),
  defineRoute(
    'organization-staff.create',
    'POST',
    '/api/v2/organizations/:organizationId/staff',
    'staff',
    { permission: 'staff.manage', scope: 'Organization membership', idempotency: 'REQUIRED' },
  ),
  defineRoute('door-sessions.create', 'POST', '/api/v2/door/sessions', 'door', {
    consumers: 'Scanner App and Partner door operations',
    auth: 'SCANNER',
    permission: 'door.session.create',
    scope: 'Assigned venue/event/door/device',
    idempotency: 'REQUIRED',
    status: 'BLOCKED',
  }),
  defineRoute('door-sessions.get', 'GET', '/api/v2/door/sessions/:sessionId', 'door', {
    consumers: 'Scanner App',
    auth: 'SCANNER',
    permission: 'door.session.read',
    scope: 'Bound scanner session',
    cache: 'NO_STORE',
    status: 'BLOCKED',
  }),
  defineRoute('door-check-ins.create', 'POST', '/api/v2/door/check-ins', 'door', {
    consumers: 'Scanner App',
    auth: 'SCANNER',
    permission: 'ticket.check_in',
    scope: 'Bound event/door/device and entitlement',
    idempotency: 'REQUIRED',
    status: 'BLOCKED',
  }),
  defineRoute('door-check-ins.get', 'GET', '/api/v2/door/check-ins/:checkInId', 'door', {
    consumers: 'Scanner and Partner operations',
    auth: 'SCANNER',
    permission: 'door.read',
    scope: 'Bound event/door',
    cache: 'NO_STORE',
    status: 'BLOCKED',
  }),
  ...(['lookup', 'override', 'offline-manifest', 'offline-sync'] as const).map((action) =>
    defineRoute(
      `door.${action}`,
      action === 'offline-manifest' ? 'GET' : 'POST',
      `/api/v2/door/${action}`,
      'door',
      {
        consumers: 'Scanner App',
        auth: 'SCANNER',
        permission: action === 'override' ? 'ticket.override' : 'door.read',
        scope: 'Bound event/door/device',
        idempotency: action === 'offline-manifest' ? 'NONE' : 'REQUIRED',
        status: 'BLOCKED',
      },
    ),
  ),

  ...(
    ['summary', 'orders', 'payments', 'refunds', 'ledger', 'commissions', 'balances'] as const
  ).map((resource) =>
    defineRoute(
      `finance.${resource}`,
      'GET',
      `/api/v2/organizations/:organizationId/finance/${resource}`,
      'finance',
      {
        permission: 'finance.read',
        scope: 'Organization finance scope',
        cache: resource === 'summary' ? 'PRIVATE_SHORT' : 'NO_STORE',
        status: 'BLOCKED',
      },
    ),
  ),
  defineRoute(
    'bank-accounts.list',
    'GET',
    '/api/v2/organizations/:organizationId/bank-accounts',
    'payouts',
    {
      permission: 'bank_account.manage',
      scope: 'Organization finance scope',
      cache: 'NO_STORE',
      status: 'BLOCKED',
    },
  ),
  defineRoute(
    'bank-accounts.create',
    'POST',
    '/api/v2/organizations/:organizationId/bank-accounts',
    'payouts',
    {
      permission: 'bank_account.manage',
      scope: 'Organization finance scope',
      idempotency: 'REQUIRED',
      status: 'BLOCKED',
    },
  ),
  defineRoute('payouts.list', 'GET', '/api/v2/organizations/:organizationId/payouts', 'payouts', {
    permission: 'finance.read',
    scope: 'Organization finance scope',
    cache: 'NO_STORE',
    status: 'BLOCKED',
  }),
  defineRoute(
    'payouts.create',
    'POST',
    '/api/v2/organizations/:organizationId/payouts',
    'payouts',
    {
      permission: 'payout.request',
      scope: 'Organization available balance',
      idempotency: 'REQUIRED',
      status: 'BLOCKED',
    },
  ),
  defineRoute('payouts.get', 'GET', '/api/v2/payouts/:payoutId', 'payouts', {
    permission: 'finance.read',
    scope: 'Payout organization/platform',
    cache: 'NO_STORE',
    status: 'BLOCKED',
  }),
  ...(['approve', 'cancel'] as const).map((action) =>
    defineRoute(`payouts.${action}`, 'POST', `/api/v2/payouts/:payoutId/${action}`, 'payouts', {
      permission: `payout.${action}`,
      scope: 'Authorized finance/platform and payout state',
      idempotency: 'REQUIRED',
      expectedVersion: 'REQUIRED',
      status: 'BLOCKED',
    }),
  ),
  webhook('webhooks.payouts', '/api/v2/webhooks/payouts/:provider', 'payouts'),

  defineRoute(
    'campaigns.list',
    'GET',
    '/api/v2/organizations/:organizationId/campaigns',
    'campaigns',
    { permission: 'campaign.read', scope: 'Organization membership' },
  ),
  defineRoute(
    'campaigns.create',
    'POST',
    '/api/v2/organizations/:organizationId/campaigns',
    'campaigns',
    {
      permission: 'campaign.create',
      scope: 'Organization membership/consent policy',
      idempotency: 'REQUIRED',
    },
  ),
  defineRoute('campaigns.get', 'GET', '/api/v2/campaigns/:campaignId', 'campaigns', {
    permission: 'campaign.read',
    scope: 'Campaign organization',
  }),
  defineRoute('campaigns.update', 'PATCH', '/api/v2/campaigns/:campaignId', 'campaigns', {
    permission: 'campaign.create',
    scope: 'Campaign organization/state/version',
    idempotency: 'REQUIRED',
    expectedVersion: 'REQUIRED',
  }),
  ...(['estimate', 'schedule', 'send', 'cancel'] as const).map((action) =>
    defineRoute(
      `campaigns.${action}`,
      'POST',
      `/api/v2/campaigns/:campaignId/${action}`,
      'campaigns',
      {
        permission: `campaign.${action === 'estimate' ? 'read' : 'send'}`,
        scope: 'Campaign organization/consent/state',
        idempotency: 'REQUIRED',
        expectedVersion: action === 'estimate' ? 'NONE' : 'REQUIRED',
      },
    ),
  ),
  defineRoute(
    'campaign-deliveries.list',
    'GET',
    '/api/v2/campaigns/:campaignId/deliveries',
    'campaigns',
    { permission: 'campaign.read', scope: 'Campaign organization' },
  ),

  defineRoute('notifications.list', 'GET', '/api/v2/notifications', 'notifications', {
    consumers: 'Partner, Guest and Mobile',
    auth: 'USER',
    permission: 'notification.read',
    scope: 'Self',
    cache: 'NO_STORE',
  }),
  defineRoute(
    'notifications.read',
    'POST',
    '/api/v2/notifications/:notificationId/read',
    'notifications',
    {
      consumers: 'Partner, Guest and Mobile',
      auth: 'USER',
      permission: 'notification.read',
      scope: 'Self and notification ownership',
      idempotency: 'REQUIRED',
    },
  ),
  defineRoute(
    'notification-preferences.get',
    'GET',
    '/api/v2/notification-preferences',
    'notifications',
    {
      consumers: 'Guest and Mobile',
      auth: 'USER',
      permission: 'notification-preferences.read',
      scope: 'Self',
      cache: 'NO_STORE',
    },
  ),
  defineRoute(
    'notification-preferences.update',
    'PATCH',
    '/api/v2/notification-preferences',
    'notifications',
    {
      consumers: 'Guest and Mobile',
      auth: 'USER',
      permission: 'notification-preferences.manage',
      scope: 'Self and version',
      idempotency: 'REQUIRED',
      expectedVersion: 'REQUIRED',
    },
  ),

  defineRoute('conversations.list', 'GET', '/api/v2/conversations', 'social', {
    consumers: 'Guest Portal and Mobile App',
    auth: 'USER',
    permission: 'conversation.read',
    scope: 'Conversation membership',
  }),
  defineRoute('conversations.create', 'POST', '/api/v2/conversations', 'social', {
    consumers: 'Guest Portal and Mobile App',
    auth: 'USER',
    permission: 'conversation.create',
    scope: 'Self and conversation eligibility',
    idempotency: 'REQUIRED',
  }),
  defineRoute('conversations.get', 'GET', '/api/v2/conversations/:conversationId', 'social', {
    auth: 'USER',
    permission: 'conversation.read',
    scope: 'Conversation membership',
  }),
  defineRoute(
    'conversation-members.list',
    'GET',
    '/api/v2/conversations/:conversationId/members',
    'social',
    { auth: 'USER', permission: 'conversation.read', scope: 'Conversation membership' },
  ),
  defineRoute(
    'conversation-messages.list',
    'GET',
    '/api/v2/conversations/:conversationId/messages',
    'social',
    { auth: 'USER', permission: 'conversation.read', scope: 'Conversation membership' },
  ),
  defineRoute(
    'conversation-messages.create',
    'POST',
    '/api/v2/conversations/:conversationId/messages',
    'social',
    {
      auth: 'USER',
      permission: 'conversation.send',
      scope: 'Conversation membership and moderation policy',
      idempotency: 'REQUIRED',
    },
  ),
  defineRoute('social-blocks.list', 'GET', '/api/v2/social/blocks', 'social', {
    auth: 'USER',
    permission: 'social.read',
    scope: 'Self',
  }),
  defineRoute('social-blocks.create', 'POST', '/api/v2/social/blocks', 'social', {
    auth: 'USER',
    permission: 'social.block',
    scope: 'Self',
    idempotency: 'REQUIRED',
  }),
  defineRoute('social-reports.create', 'POST', '/api/v2/social/reports', 'social', {
    auth: 'USER',
    permission: 'social.report',
    scope: 'Self and report target',
    idempotency: 'REQUIRED',
  }),
  defineRoute('social-moderation', 'POST', '/api/v2/social/moderation', 'social', {
    consumers: 'Admin Console',
    auth: 'ADMIN',
    permission: 'social.moderate',
    scope: 'Platform moderation scope',
    idempotency: 'REQUIRED',
    audit: 'ADMIN_SENSITIVE',
  }),

  defineRoute(
    'organization-analytics',
    'GET',
    '/api/v2/organizations/:organizationId/analytics/overview',
    'analytics',
    { permission: 'analytics.read', scope: 'Organization membership', cache: 'PRIVATE_SHORT' },
  ),
  defineRoute('event-analytics', 'GET', '/api/v2/events/:eventId/analytics', 'analytics', {
    permission: 'analytics.read',
    scope: 'Event organization/assignment',
    cache: 'PRIVATE_SHORT',
  }),
  defineRoute('promoter-analytics', 'GET', '/api/v2/promoters/:promoterId/analytics', 'analytics', {
    permission: 'analytics.read',
    scope: 'Self or authorized organization',
    cache: 'PRIVATE_SHORT',
  }),
  defineRoute('campaign-analytics', 'GET', '/api/v2/campaigns/:campaignId/analytics', 'analytics', {
    permission: 'campaign.read',
    scope: 'Campaign organization',
    cache: 'PRIVATE_SHORT',
  }),

  ...(
    [
      'organizations',
      'users',
      'events',
      'orders',
      'refunds',
      'payouts',
      'reports',
      'audit',
      'configuration',
    ] as const
  ).map((resource) =>
    defineRoute(`admin.${resource}`, 'GET', `/api/v2/admin/${resource}`, 'admin', {
      consumers: 'Admin Console',
      auth: 'ADMIN',
      permission: `admin.${resource}.read`,
      scope: 'Platform-admin scope',
      rateLimit: 'ADMIN_COMMAND',
      audit: 'ADMIN_READ',
      cache: 'NO_STORE',
      status: 'PLANNED',
    }),
  ),
] as const;

export const ACTIVE_API_V2_ROUTES = API_V2_ROUTES.filter((route) => route.status === 'ACTIVE');
