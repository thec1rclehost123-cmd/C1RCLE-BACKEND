# Security Model

Observed controls include session/auth proxies, CSRF-related BFF code, schema validation, provider adapters, organization access helpers, and backend route/service boundaries. Risks requiring explicit release evidence include tenant isolation, cookie/header propagation, webhook signature verification, idempotency, secret/config separation, Firestore rules/indexes, PII minimization, and redacted logs.

No secret values are included in this audit. Production and Razorpay Live Mode were not accessed.
