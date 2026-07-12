import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/user.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { kycUpload, avatarUpload } from '../middleware/upload.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { KYC_DOC_TYPES } from '../config/constants.js';

const router = Router();

router.get('/me', requireAuth, ctrl.me);

router.patch(
  '/me',
  requireAuth,
  validate({
    body: z.object({
      email: z.string().email().optional(),
      username: z
        .string()
        .trim()
        .min(3)
        .max(30)
        .regex(/^[a-zA-Z0-9_]+$/, 'letters, numbers, and underscores only')
        .optional(),
      fullName: z.string().trim().min(2).max(100).optional(),
    }),
  }),
  ctrl.updateMe,
);

// Profile picture: upload/replace (POST) and remove (DELETE). Public asset,
// single image parsed by the avatarUpload multer middleware.
router.post('/me/avatar', requireAuth, authLimiter, avatarUpload, ctrl.uploadAvatarImage);
router.delete('/me/avatar', requireAuth, ctrl.deleteAvatarImage);

// multipart: kycUpload (multer) parses files + text fields, then zod checks docType.
// Frozen users may still complete KYC — verification is not a transaction.
router.post(
  '/kyc',
  requireAuth,
  authLimiter,
  kycUpload,
  validate({ body: z.object({ docType: z.enum(KYC_DOC_TYPES) }) }),
  ctrl.submitKyc,
);

export default router;
