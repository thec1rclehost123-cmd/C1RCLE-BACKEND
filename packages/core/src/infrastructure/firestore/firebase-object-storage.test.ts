import { describe, expect, it, vi } from 'vitest';

import { FirebaseObjectStorage } from './firebase-object-storage.js';

describe('FirebaseObjectStorage.issueUploadUrl', () => {
  it('signs a short public cache lifetime into poster upload metadata', async () => {
    const getSignedUrl = vi.fn(async () => ['https://signed.test/upload']);
    const storage = {
      bucket: vi.fn(() => ({ file: vi.fn(() => ({ getSignedUrl })) })),
    };
    const adapter = new FirebaseObjectStorage(storage as never, 'c1rcle-test');

    const grant = await adapter.issueUploadUrl({
      key: 'posters/org-1/event.webp',
      contentType: 'image/webp',
      maxBytes: 1024,
      expiresAt: 10_000,
      visibility: 'public',
    });

    expect(getSignedUrl).toHaveBeenCalledWith({
      version: 'v4',
      action: 'write',
      expires: 10_000,
      contentType: 'image/webp',
      extensionHeaders: {
        'x-goog-content-length-range': '0,1024',
        'x-goog-acl': 'public-read',
        'cache-control': 'public, max-age=60',
      },
    });
    expect(grant.headers).toMatchObject({
      'x-goog-acl': 'public-read',
      'cache-control': 'public, max-age=60',
    });
  });

  it('does not make private uploads publicly cacheable', async () => {
    const getSignedUrl = vi.fn(async (options: { extensionHeaders?: Record<string, string> }) => {
      void options;
      return ['https://signed.test/upload'];
    });
    const storage = {
      bucket: vi.fn(() => ({ file: vi.fn(() => ({ getSignedUrl })) })),
    };
    const adapter = new FirebaseObjectStorage(storage as never, 'c1rcle-test');

    const grant = await adapter.issueUploadUrl({
      key: 'kyc/user/front.jpg',
      contentType: 'image/jpeg',
      maxBytes: 1024,
      expiresAt: 10_000,
    });

    expect(getSignedUrl.mock.calls[0]?.[0].extensionHeaders).not.toHaveProperty('cache-control');
    expect(grant.headers).not.toHaveProperty('cache-control');
  });
});

describe('FirebaseObjectStorage.revokePublicRead', () => {
  it('revokes only managed poster objects in its configured bucket', async () => {
    const deleteAcl = vi.fn(async () => undefined);
    const setMetadata = vi.fn(async () => undefined);
    const file = { acl: { delete: deleteAcl }, setMetadata };
    const storage = {
      bucket: vi.fn(() => ({ file: vi.fn(() => file) })),
    };
    const adapter = new FirebaseObjectStorage(storage as never, 'c1rcle-test');

    await expect(
      adapter.revokePublicRead(
        'https://storage.googleapis.com/c1rcle-test/posters/org-1/event.webp',
        'posters/org-1/',
      ),
    ).resolves.toBe('posters/org-1/event.webp');
    expect(deleteAcl).toHaveBeenCalledWith({ entity: 'allUsers' });
    expect(setMetadata).toHaveBeenCalledWith({ cacheControl: 'private, no-store' });
  });

  it.each([
    'https://storage.googleapis.com/other-bucket/posters/org-1/event.webp',
    'https://storage.googleapis.com/c1rcle-test/kyc/user/front.jpg',
    'https://example.test/posters/org-1/event.webp',
    'https://storage.googleapis.com/c1rcle-test/posters/org-2/event.webp',
    'not a URL',
  ])('does not resolve a foreign or non-poster URL: %s', async (url) => {
    const file = {
      acl: { delete: vi.fn(async () => undefined) },
      setMetadata: vi.fn(async () => undefined),
    };
    const storage = {
      bucket: vi.fn(() => ({ file: vi.fn(() => file) })),
    };
    const adapter = new FirebaseObjectStorage(storage as never, 'c1rcle-test');

    await expect(adapter.revokePublicRead(url, 'posters/org-1/')).resolves.toBeNull();
    expect(storage.bucket).not.toHaveBeenCalled();
  });

  it('treats a missing object or ACL as already revoked', async () => {
    const deleteAcl = vi.fn(async () => {
      throw Object.assign(new Error('Not found'), { code: 404 });
    });
    const setMetadata = vi.fn(async () => {
      throw Object.assign(new Error('Not found'), { code: 404 });
    });
    const file = { acl: { delete: deleteAcl }, setMetadata };
    const storage = {
      bucket: vi.fn(() => ({ file: vi.fn(() => file) })),
    };
    const adapter = new FirebaseObjectStorage(storage as never, 'c1rcle-test');

    await expect(
      adapter.revokePublicRead(
        'https://storage.googleapis.com/c1rcle-test/posters/org-1/missing.webp',
        'posters/org-1/',
      ),
    ).resolves.toBe('posters/org-1/missing.webp');
  });
});
