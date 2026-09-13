/**
 * ─── Object storage — pre-signed upload URLs (Phase 2 gap) ───────────────────
 *
 * Onboarding needs three KYC images (`id_front`, `id_back`, `selfie`). The
 * browser must never hold a storage credential and the gateway must never
 * proxy the bytes, so the applicant asks the API for a short-lived,
 * content-type-bound, size-bound URL and `PUT`s the file straight to the
 * bucket. `POST .../documents` then records the resulting `storagePath`.
 *
 * This port is the seam. The domain states what an upload grant *is*; a real
 * GCS/Firebase Storage v4 signature, an S3 pre-signed POST, or the dev echo
 * stub all satisfy it without the onboarding flow changing.
 */

export interface UploadUrlRequest {
  /** Object path inside the bucket, e.g. `kyc/<userId>/<applicationId>/<label>`. */
  readonly key: string;
  /** The exact `Content-Type` the client must send on the `PUT`. */
  readonly contentType: string;
  /** Upper bound the signature enforces, in bytes. */
  readonly maxBytes: number;
  /** Absolute expiry, epoch ms — computed by the caller from the injected clock. */
  readonly expiresAt: number;
}

export interface UploadUrlGrant {
  /** Where the client `PUT`s the file. Opaque; never logged in full. */
  readonly uploadUrl: string;
  readonly method: 'PUT';
  /** Headers the client must send on the `PUT`, verbatim. */
  readonly headers: Readonly<Record<string, string>>;
  /** What the client passes back to `POST .../documents` as `storagePath`. */
  readonly storagePath: string;
  /** Echoes the request's `expiresAt`, epoch ms. */
  readonly expiresAt: number;
}

export interface ReadUrlRequest {
  /** The exact same object key an `issueUploadUrl` call wrote to. */
  readonly key: string;
  /** Absolute expiry, epoch ms. Short-lived — minted per admin view, not cached. */
  readonly expiresAt: number;
}

export interface ReadUrlGrant {
  /** Where to `GET` the file. Opaque; never logged in full. */
  readonly readUrl: string;
  /** Echoes the request's `expiresAt`, epoch ms. */
  readonly expiresAt: number;
}

export interface ObjectStoragePort {
  /** Recorded so a provider swap is visible in support history. */
  readonly name: string;
  issueUploadUrl(request: UploadUrlRequest): Promise<UploadUrlGrant>;
  /**
   * Admin-side signed read — lets a platform admin actually view a KYC
   * document before approving/rejecting an application. v1 had the same
   * idea (`kyc/[uid]/route.js` signed-URL helper) but allowlisted by path
   * prefix since it took an arbitrary collection field as the key; this
   * port only ever signs a key the caller derived from an `OnboardingRequest`
   * it already loaded, so the prefix allowlist has no separate job to do here.
   */
  issueReadUrl(request: ReadUrlRequest): Promise<ReadUrlGrant>;
}

/**
 * The default provider for `STORAGE_DRIVER=memory` (tests, CI, local dev with
 * no bucket): it hands back a non-routable `memory://` URL and the same key as
 * the storagePath, so the onboarding flow can be exercised end to end without
 * a real upload ever happening. It stores nothing.
 */
export class EchoObjectStorage implements ObjectStoragePort {
  readonly name = 'echo-dev';

  async issueUploadUrl(request: UploadUrlRequest): Promise<UploadUrlGrant> {
    return {
      uploadUrl: `memory://uploads/${request.key}`,
      method: 'PUT',
      headers: { 'content-type': request.contentType },
      storagePath: request.key,
      expiresAt: request.expiresAt,
    };
  }

  async issueReadUrl(request: ReadUrlRequest): Promise<ReadUrlGrant> {
    return {
      readUrl: `memory://reads/${request.key}`,
      expiresAt: request.expiresAt,
    };
  }
}
