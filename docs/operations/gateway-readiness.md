# Gateway readiness

The Gateway exposes three unauthenticated, non-cached internal endpoints:

| Endpoint | Meaning |
| --- | --- |
| `/api/v2/internal/health` | Process liveness only. It does not probe dependencies. |
| `/api/v2/internal/version` | Build identity and process start time. |
| `/api/v2/internal/readiness` | Current required probe results. Any failed/throwing probe or shutdown state returns 503. |

Validated configuration is required to construct the app. The `configuration: up` field means that validation succeeded; it does not establish provider credentials, deployed indexes, IAM coverage or business workflow acceptance.

With the Firestore driver, readiness calls Firestore `listCollections` and Storage bucket `getMetadata`. These are read-only metadata operations, not an exhaustive test of repository permissions, transactions, object uploads or query indexes. Redis is probed with `PING` only when the Gateway owns an active rate-limit Redis client. Memory fallback does not make a failed required Redis probe green.

The existing `paymentProvider` field checks only presence of the three Razorpay configuration values when any is supplied. It makes no provider request. It is **not** evidence of Razorpay connectivity, valid credentials, webhook configuration or Test Mode acceptance. With none supplied, this check is omitted and payment routes remain unconfigured. Email and bank-key safety are separate configuration/provider readiness work in Packet 2.5.

Each built-in probe waiter has a 2,000 ms budget. Dependency checks currently execute serially, so the entire endpoint can take longer than one probe budget. A timer cannot preempt synchronous JavaScript and does not cancel an already-running SDK operation. Concurrent requests and retries share that unfinished operation instead of launching more copies. They still time out and report down. When it settles, its result is not cached: the next invocation performs a fresh check. An indefinitely stuck underlying operation keeps that dependency down until it settles or the process is safely restarted; there is no optimistic recovery or overlapping replacement RPC.

## Investigation evidence, 2026-11-03

Packet 2.3 retained diagnostics outside the repository under `C1RCLE-M2-PACKET-2.3-20261103` on the development machine. No secrets, collection names or business records were printed. Workers and payouts were disabled; all connected calls were metadata reads against approved non-production project `c1rcle-v2`.

- Historical evidence showed Firestore down, Storage up and the payment configuration check up. Its separate metadata read succeeded in 1,668 ms. That snapshot did not retain actual failing RPC completion/error timing, so its precise cause remains **UNVERIFIED**.
- Current direct probes succeeded: Firestore cold 1,715 ms, then 1,533/430 ms. Storage cold 2,097 ms and warm 287/916 ms illustrate that observed wall time is not a hard synchronous-initialization deadline.
- Actual Gateway handlers with connected metadata dependencies returned readiness 200 at 3,292 ms cold and 700/1,188 ms warm. Firestore portions were 1,684/408/801 ms. Health/version also returned 200. These are Fastify-injected handler checks, not a listener, edge/load-balancer or staging deployment test.
- A focused failure-before regression demonstrated overlapping dependency calls. The local fix bounds each probe to one unfinished operation without extending the timeout, caching a green result, weakening failures or performing startup writes.

Do not mark the historical startup timeout resolved from these successful samples. If it recurs, retain request timing, dependency identity, SDK error code and eventual completion timing without recording credentials or collection contents. Compare process-cold and warm attempts before changing a timeout or deployment health-check policy. No timeout or deployment policy was changed in this packet.
