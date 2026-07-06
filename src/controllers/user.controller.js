import * as userService from '../services/user.service.js';
import {
  uploadVerificationDocs,
  deleteVerificationDoc,
} from '../utils/cloudinary.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logger } from '../config/logger.js';

export const me = asyncHandler(async (req, res) => {
  res.json({ success: true, profile: await userService.getProfile(req.user._id) });
});

export const updateMe = asyncHandler(async (req, res) => {
  const profile = await userService.updateProfile(req.user._id, req.validated.body);
  res.json({ success: true, profile });
});

/**
 * multipart/form-data (parsed by middleware/upload.js kycUpload):
 *   docType  — passport | voters_card | nin | drivers_license (zod-validated)
 *   document — 1–2 files (front/back), image or PDF
 *   selfie   — optional live-capture image
 */
export const submitKyc = asyncHandler(async (req, res) => {
  const { docType } = req.validated.body;
  const documentFiles = req.files?.document ?? [];
  const selfieFiles = req.files?.selfie ?? [];
  if (documentFiles.length === 0) {
    throw ApiError.badRequest('Attach the identity document as "document"', 'KYC_DOCUMENTS_REQUIRED');
  }

  // All files go up in parallel as private assets under the user's folder
  const folder = `kyc/${req.user.id}`;
  const [docUploads, selfieUploads] = await Promise.all([
    uploadVerificationDocs(documentFiles, folder),
    uploadVerificationDocs(selfieFiles, folder),
  ]);

  const documents = [
    ...docUploads.map((u) => ({ kind: docType, ...u })),
    ...selfieUploads.map((u) => ({ kind: 'selfie', ...u })),
  ];

  let result;
  try {
    result = await userService.submitKyc(req.user._id, documents);
  } catch (err) {
    // submission rejected (e.g. already pending) — don't leak the fresh uploads
    await Promise.allSettled(documents.map((d) => deleteVerificationDoc(d.publicId, d.resourceType)));
    throw err;
  }

  // resubmission after rejection: clear the replaced assets, best-effort
  const stale = result.previousDocuments.filter((d) => d.publicId);
  if (stale.length) {
    Promise.allSettled(stale.map((d) => deleteVerificationDoc(d.publicId, d.resourceType))).then(
      (outcomes) => {
        const failed = outcomes.filter((o) => o.status === 'rejected').length;
        if (failed) logger.warn({ user: req.user.id, failed }, 'Stale KYC asset cleanup incomplete');
      },
    );
  }

  res.status(201).json({ success: true, status: result.status, submittedAt: result.submittedAt });
});
