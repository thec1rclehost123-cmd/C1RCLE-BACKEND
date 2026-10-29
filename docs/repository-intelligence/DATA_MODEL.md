# Data Model

Backend domain models and repositories cover orders, venues, availability/slots, events, payments, refunds, journals, payouts, door/scanner, organizations, analytics, email delivery, and Firestore persistence.

Persistence and durable state are backend-authoritative. Indexes, migrations/backfills, and Firestore rules require separate read-only review and staging validation.
