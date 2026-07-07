import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter, captchaLimiter } from '../middleware/rateLimit.js';
import { CAPTCHA_PURPOSES } from '../config/constants.js';
import { SECURITY_QUESTION_IDS } from '../config/securityQuestions.js';

const router = Router();

// --- shared field schemas ---
const captchaFields = {
  captchaId: z.string().length(24), // Mongo ObjectId hex
  captchaAnswer: z.string().min(1).max(10),
};
const password = z.string().min(8).max(128);
const identifier = z.string().min(3).max(254); // email or phone
const totp = z.string().regex(/^\d{6}$/, 'must be a 6-digit code');
const pin = z.string().regex(/^\d{4,6}$/, 'must be 4-6 digits');

// --- public ---
// Predefined list the frontend renders as the registration dropdown
router.get('/security-questions', ctrl.listSecurityQuestions);

router.get(
  '/captcha',
  captchaLimiter,
  validate({ query: z.object({ purpose: z.enum(CAPTCHA_PURPOSES) }) }),
  ctrl.getCaptcha,
);

router.post(
  '/register',
  authLimiter,
  validate({
    body: z.object({
      phone: z.string().min(7).max(20),
      email: z.string().email(),
      username: z
        .string()
        .trim()
        .min(3)
        .max(30)
        .regex(/^[a-zA-Z0-9_]+$/, 'letters, numbers, and underscores only'),
      fullName: z.string().trim().min(2).max(100),
      password,
      referralCode: z.string().trim().min(4).max(12).optional(),
      securityQuestionId: z.enum(SECURITY_QUESTION_IDS),
      securityAnswer: z.string().trim().min(2).max(100),
      ...captchaFields,
    }),
  }),
  ctrl.register,
);

router.post(
  '/login',
  authLimiter,
  validate({
    body: z.object({ identifier, password: z.string().min(1).max(128), totp: totp.optional(), ...captchaFields }),
  }),
  ctrl.login,
);

router.post('/refresh', ctrl.refresh);
router.post('/logout', ctrl.logout);

router.get(
  '/security-question',
  authLimiter,
  validate({ query: z.object({ identifier }) }),
  ctrl.getSecurityQuestion,
);

router.post(
  '/reset-password',
  authLimiter,
  validate({
    body: z.object({ identifier, answer: z.string().min(1).max(100), newPassword: password, ...captchaFields }),
  }),
  ctrl.resetPassword,
);

// --- authenticated ---
router.get('/me', requireAuth, ctrl.me);

router.post(
  '/change-password',
  requireAuth,
  validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: password }) }),
  ctrl.changePassword,
);

router.post(
  '/security-question/change',
  requireAuth,
  validate({
    body: z.object({
      password: z.string().min(1),
      questionId: z.enum(SECURITY_QUESTION_IDS),
      answer: z.string().trim().min(2).max(100),
    }),
  }),
  ctrl.changeSecurityQuestion,
);

router.post('/2fa/enable', requireAuth, ctrl.enable2fa);
router.post('/2fa/confirm', requireAuth, validate({ body: z.object({ totp }) }), ctrl.confirm2fa);
router.post('/2fa/disable', requireAuth, validate({ body: z.object({ totp }) }), ctrl.disable2fa);

router.post(
  '/withdrawal-pin',
  requireAuth,
  validate({ body: z.object({ pin, totp: totp.optional(), password: z.string().min(1).optional() }) }),
  ctrl.setWithdrawalPin,
);

export default router;
