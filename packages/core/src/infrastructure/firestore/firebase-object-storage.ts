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

    const [uploadUrl] = await this.storage
      .bucket(this.bucketName)
      .file(request.key)
      .getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: request.expiresAt,
        contentType: request.contentType,
        extensionHeaders: { 'x-goog-content-length-range': contentLengthRange },
      });

    return {
      uploadUrl,
      method: 'PUT',
      headers: {
        'content-type': request.contentType,
        'x-goog-content-length-range': contentLengthRange,
      },
      storagePath: request.key,
      expiresAt: request.expiresAt,
    };
  }
}
