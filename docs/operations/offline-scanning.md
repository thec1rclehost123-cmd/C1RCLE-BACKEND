# Offline door scanning

How a scanner device decides "is this ticket genuine?" with no signal, and how the server reconciles it later. Implementation: `packages/core/src/application/door/offline-ticket-crypto.ts` and `scanner-service.ts`. Known-answer vectors the device must reproduce: `offline-ticket-crypto.test.ts`.

## Model

| | Online scan | Offline scan |
|---|---|---|
| Who decides | Server, atomically (`claimAdmission`) | Device provisionally; **server re-decides at sync** |
| QR check | Server recomputes the code as of *now* | Device checks with the per-ticket key from its manifest, as of the device clock |
| Secret on device | none | per-ticket keys for one event, for at most 12 h |

The master secret (`MAGIC_TICKET_SECRET`) never leaves the server. Stealing a scanner exposes only the verification keys of one event's tickets until the manifest expires; it cannot mint or verify any other ticket.

## Rotating QR

`ticketKey = HMAC-SHA256(MAGIC_TICKET_SECRET, "ticket-key|" + entitlementId)` (hex).
QR payload: `entitlementId:windowStart:HMAC-SHA256(ticketKey, "entitlementId:windowStart")` (hex), where `windowStart = floor(unixSeconds / 30) * 30`.

A code verifies as of a time `t` when the signature matches the claimed window (or the window before it) **and** the claimed window is within two windows (60 s) of `windowStart(t)`. Online, `t` is the server's now. Offline sync, `t` is the device's scan time, so a code that was fresh when scanned still verifies hours later while a replayed screenshot does not.

## Manifest (`GET /door/offline-manifest?eventId=...`)

Needs a scanner session that may scan. Response:

```
{ version: 1, eventId, signedAt, expiresAt,       // expiresAt = signedAt + 12 h
  keyId, publicKey (base64 raw Ed25519), manifestSignature (base64),
  manifest: [{ entitlementId, validFrom, validTo, ticketKey }] }
```

Included: tickets that are not void, not under a refund lock, and not already fully scanned. **Not** included: anything issued after `signedAt` (such a ticket must be scanned online).

The signature covers these exact bytes (UTF-8):

```
c1rcle-offline-manifest-v1\n<eventId>\n<signedAt>\n<expiresAt>\n<sha256hex(lines)>
lines = for each entry sorted by entitlementId (plain string compare):
        "<entitlementId>|<validFrom>|<validTo>|<ticketKey>\n"
```

The Ed25519 key is derived from `MAGIC_TICKET_SECRET` via HKDF-SHA256 (salt `c1rcle`, info `offline-manifest-ed25519-v1`), so there is no extra secret to provision and every API instance signs identically. Rotating `MAGIC_TICKET_SECRET` rotates the signing key and every ticket key at once; a device must refuse a manifest whose `version` it does not know.

The device should verify `manifestSignature` against `publicKey` before trusting any entry, and should pin `keyId` per event so a swapped key is visible. Note the public key arrives in the same response, so the signature detects tampering of a *stored* manifest, not a hostile server connection (TLS covers that).

## Sync (`POST /door/offline-sync`)

Each scan `{ payload, scannedAt, deviceId }` is re-run through the full server decision:

1. `scannedAt` must be parseable, not more than 5 minutes in the future, and not older than 36 h (12 h manifest life + 24 h grace to sync a shift's backlog). Otherwise the entry is refused as `offline_expired` and the ticket is **not** spent.
2. A rotating code is verified as of `scannedAt`; a bad or out-of-window signature is `invalid_signature`. A bare ticket id (legacy static QR) is still accepted, as online.
3. The admission is claimed atomically. If another device already admitted the ticket, the entry comes back as `already_used` in `conflicts`: the operator's list of who got in on a ticket that was already spent.

## Limits you should know about

- **Refunds/voids are invisible to a device until it syncs.** The manifest is a snapshot.
- **Two offline gates can both admit the same ticket.** The server admits it once and reports the second as a conflict at sync. If a venue cannot accept that, give each gate its own ticket subset (not built) or keep entry points online.
- **`scannedAt` is the device's claim.** It is bounded as above but not provable; this relies on scanner sessions being issued only to trusted staff (`device` binding and session revocation still apply online).
- **Manifest size.** Each entry is roughly 250 bytes; an event with tens of thousands of tickets produces a multi-megabyte response. Pagination or per-gate manifests are a follow-up if that becomes real.
- The scanner app (`C1RCLE-FRONTEND/apps/scanner-app`) does not call these endpoints yet; this document is its spec.
