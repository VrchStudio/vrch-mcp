/* Shared streaming file digest for HTTPS and USB HTTP clients. */
'use strict';
importScripts('./vrch_pages_sha256_fallback.js?v=20261009-apps-a1');
self.onmessage = async ({data}) => {
  const {id, blob, end = blob?.size} = data;
  try {
    if (!(blob instanceof Blob) || !Number.isSafeInteger(end) || end < 0 || end > blob.size) throw new Error('Invalid file.');
    const hash = self.VrchSha256Fallback.create();
    for (let offset = 0; offset < end; offset += 1024 * 1024) {
      hash.update(await blob.slice(offset, Math.min(offset + 1024 * 1024, end)).arrayBuffer());
      self.postMessage({id, progress: Math.min(offset + 1024 * 1024, end), total: end});
    }
    const sha256 = Array.from(new Uint8Array(hash.digest()), value => value.toString(16).padStart(2, '0')).join('');
    self.postMessage({id, sha256});
  } catch (error) { self.postMessage({id, error: error.message}); }
};
