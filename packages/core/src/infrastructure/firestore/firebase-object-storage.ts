/**
 * ─── Firebase Storage upload grants (v4 signed URLs) ─────────────────────────
 *
 * The `STORAGE_DRIVER=firestore` implementation of `ObjectStoragePort`. Issues
 * a short-lived v4 signed `PUT` URL bound to an exact `Content-Type` and a
 * byte-length range, so the browser uploads a KYC image straight to the bucket
 * without the gateway ever touching the bytes or a credential.
 *
 * Lives in this directory because it is the only place `firebase-admin` may be
 * imported (`scripts/check-boundaries.mjs` Rule 3 exemption); it takes the
 * `Storage` handle from `./client.js` rather than initialising its own app.
 */
import type { Storage } from './client.js';
import type {
  ObjectStoragePort,
  UploadUrlGrant,
  UploadUrlRequest,
} from '../../domain/ports/object-storage.js';

export class FirebaseObjectStorage implements ObjectStoragePort {
  readonly name = 'firebase-storage-v4';

  constructor(
    private readonly storage: Storage,
    private readonly bucketName: string,
  ) {}

  async issueUploadUrl(request: UploadUrlRequest): Promise<UploadUrlGrant> {
    const contentLengthRange = `0,${String(request.maxBytes)}`;

    // `x-goog-acl` is signed into the URL so the browser's PUT *sets* the
    // object's ACL on upload. Only a `'public'` request carries it (event
    // posters); the default `'private'` KYC path stays credential-only.
    const extensionHeaders: Record<string, string> = {
      'x-goog-content-length-range': contentLengthRange,
    };
    const putHeaders: Record<string, string> = {
      'content-type': request.contentType,
      'x-goog-content-length-range': contentLengthRange,
    };
    if (request.visibility === 'public') {
      extensionHeaders['x-goog-acl'] = 'public-read';
      putHeaders['x-goog-acl'] = 'public-read';
    }

    const [uploadUrl] = await this.storage.bucket(this.bucketName).file(request.key).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: request.expiresAt,
      contentType: request.contentType,
      extensionHeaders,
    });

    return {
      uploadUrl,
      method: 'PUT',
      headers: putHeaders,
      storagePath: request.key,
      expiresAt: request.expiresAt,
    };
  }

  toPublicUrl(storagePath: string): string {
    // Standard GCS public object URL — served without a credential when the
    // object was uploaded with `visibility: 'public'` (posters): the signed
    // PUT sets *that object's* ACL to public-read while the bucket and every
    // KYC/private object stay credential-only.
    return `https://storage.googleapis.com/${this.bucketName}/${storagePath}`;
  }
}
