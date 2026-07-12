// Multer (memory storage) for KYC verification uploads. Files stay in memory
// buffers and are streamed straight to Cloudinary — nothing touches disk.
// Multer errors are mapped to ApiError so the global handler returns clean 400s.

import multer from 'multer';
import { ApiError } from '../utils/ApiError.js';

const VERIFICATION_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/pdf',
];
// Selfies come from a live camera capture on the frontend — images only
const SELFIE_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

const verificationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 3 }, // 10 MB each — PDFs can be larger
  fileFilter: (_req, file, cb) => {
    const allowed = file.fieldname === 'selfie' ? SELFIE_MIME_TYPES : VERIFICATION_MIME_TYPES;
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(
      ApiError.badRequest(
        file.fieldname === 'selfie'
          ? 'Selfie must be an image (JPEG, PNG, WebP)'
          : 'Only images (JPEG, PNG, WebP) and PDFs are allowed',
        'INVALID_FILE_TYPE',
      ),
    );
  },
});

const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: 'File too large (max 10 MB)',
  LIMIT_FILE_COUNT: 'Too many files',
  LIMIT_UNEXPECTED_FILE: 'Unexpected file field — use "document" (up to 2) and "selfie" (1)',
};

const kycFields = verificationUpload.fields([
  { name: 'document', maxCount: 2 }, // front / back
  { name: 'selfie', maxCount: 1 },
]);

/** multipart parser for POST /users/kyc with multer errors mapped to 400s. */
export function kycUpload(req, res, next) {
  kycFields(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return next(ApiError.badRequest(MULTER_MESSAGES[err.code] ?? err.message, 'UPLOAD_REJECTED'));
    }
    next(err); // fileFilter ApiErrors pass through as-is
  });
}

// Avatars are public profile pictures — a single image, capped smaller than
// KYC docs since they're re-cropped to a 512px square anyway.
const avatarUploadFields = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (SELFIE_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
    cb(ApiError.badRequest('Avatar must be an image (JPEG, PNG, WebP)', 'INVALID_FILE_TYPE'));
  },
}).single('avatar');

const AVATAR_MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: 'Image too large (max 5 MB)',
  LIMIT_FILE_COUNT: 'Only one image is allowed',
  LIMIT_UNEXPECTED_FILE: 'Unexpected file field — use "avatar"',
};

/** multipart parser for POST /users/me/avatar with multer errors mapped to 400s. */
export function avatarUpload(req, res, next) {
  avatarUploadFields(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return next(
        ApiError.badRequest(AVATAR_MULTER_MESSAGES[err.code] ?? err.message, 'UPLOAD_REJECTED'),
      );
    }
    next(err);
  });
}
