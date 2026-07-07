// Cloudinary v2 helpers for KYC verification documents (SPEC §2.1).
// Assets are uploaded with type:'private' so they are NOT publicly fetchable —
// viewing requires a signed URL (getSignedUrl). Images get an
// incoming transformation that caps dimensions and compresses; PDFs go up as
// resource_type:'raw'. Buffers are written straight into the upload stream
// (upload_stream(...).end(buffer)) — no streamifier needed.

import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';
import { ApiError } from './ApiError.js';

const configured = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
);

if (configured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

/** Throws 503 instead of a cryptic provider error when env vars are missing. */
function assertConfigured() {
  if (!configured) {
    throw new ApiError(503, 'File uploads are not configured on this server', 'UPLOADS_UNAVAILABLE');
  }
}

/**
 * Upload one verification document as a private asset.
 * Returns { url, publicId, resourceType, bytes, format }.
 */
export function uploadVerificationDoc(fileBuffer, folder, mimeType) {
  assertConfigured();
  const isPdf = mimeType === 'application/pdf';

  const options = {
    folder,
    type: 'private', // signed delivery only — KYC documents must not be public
    resource_type: isPdf ? 'raw' : 'image',
    use_filename: false, // random public_id: unguessable even inside the folder
    unique_filename: true,
    overwrite: false,
    ...(isPdf
      ? { format: 'pdf' }
      : {
          // cap dimensions + compress on ingest; keeps originals reviewable but small
          transformation: [
            { width: 1920, height: 1920, crop: 'limit' },
            { quality: 'auto' },
          ],
        }),
  };

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(new Error(err?.message || 'Cloudinary upload failed'));
      if (!result) return reject(new Error('Cloudinary upload failed: no result returned'));
      resolve({
        url: result.secure_url || result.url,
        publicId: result.public_id,
        resourceType: isPdf ? 'raw' : 'image',
        bytes: result.bytes,
        format: result.format,
      });
    });
    stream.end(fileBuffer);
  });
}

/** Upload several multer memory files in parallel into one folder. */
export function uploadVerificationDocs(files, folder) {
  return Promise.all(files.map((f) => uploadVerificationDoc(f.buffer, folder, f.mimetype)));
}

/** Best-effort delete of a private verification asset (e.g. replaced on resubmission). */
export async function deleteVerificationDoc(publicId, resourceType = 'image') {
  if (!publicId || !configured) return null;
  return cloudinary.uploader.destroy(publicId, { type: 'private', resource_type: resourceType });
}

/**
 * Expiring signed URL so the owner/admin can view a private document inline.
 * Private ORIGINALS are not deliverable through res.cloudinary.com s--sig--
 * URLs at all (401 "deny or ACL failure") — they must go through the
 * api.cloudinary.com download endpoint (private_download_url). Verified
 * 2026-07-07: it serves both image and raw originals with the correct
 * content-type and inline disposition, so browsers render them in-page.
 * No format arg — raw public_ids already carry their extension.
 */
export function getSignedUrl(publicId, resourceType = 'image', expiresInSeconds = 3600) {
  if (!publicId || !configured) return null;
  return cloudinary.utils.private_download_url(publicId, null, {
    resource_type: resourceType,
    type: 'private',
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
  });
}
