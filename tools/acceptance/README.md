# Acceptance preparation

Run `pnpm acceptance:prepare -- prepare guest --fixture guest_canonical_paid_event` to see the staging target, public liveness, protected readiness/version state, fixture health, credential label and provider/human-action boundaries. Use `fixture <id>` for one record and `fixtures --area guest` for a compact split list. Requirements remain unbound and fail fast. `--json` emits the same summary as JSON. All network requests are bounded GETs; nothing creates or changes staging data.

The environment is a documented staging target; the current hosting branch is not independently proven here. Frontend deployed SHAs stay `UNKNOWN` until an authorized Vercel metadata source or runtime build identity is configured. Backend SHAs are read only through the existing protected version endpoint and require `NGINX_READINESS_TOKEN` in the process environment; its value is never printed or accepted on the command line. Public health is process liveness only. Readiness and provider configuration are distinct, and preparation does not validate Razorpay or Firebase with provider actions.

Outbound targets and probe paths are fixed in the helper. `surfaces.json` records the reviewed canonical origins and must match the helper's allowlist; changing an origin requires updating the allowlist and its tests. File-configured URLs and paths are never passed to `fetch`.

If Vercel protection appears, do not inject bypass headers into cross-origin browser traffic. Use the approved access procedure for the initial protected navigation and let the browser retain its cookie; this helper never reads or stores a bypass credential. Preserve browser cookies during a workflow, switch account/role deliberately and wait for usable UI state rather than a fixed sleep.
