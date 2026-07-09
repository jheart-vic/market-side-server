import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/auth.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter, captchaLimiter } from '../middleware/rateLimit.js';
import { CAPTCHA_PURPOSES } from '../config/constants.js';

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
const recoveryCode = z.string().trim().min(8).max(20); // e.g. "A3F9K-2M7QX"

// Shared registration payload (normal sign-up + "create account" in the switcher)
const registerFields = {
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
  ...captchaFields,
};

// --- public ---
router.get(
  '/captcha',
  captchaLimiter,
  validate({ query: z.object({ purpose: z.enum(CAPTCHA_PURPOSES) }) }),
  ctrl.getCaptcha,
);

router.post(
  '/register',
  authLimiter,
  validate({ body: z.object(registerFields) }),
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

// Admin login — email + password from env, no captcha (rate-limited instead)
router.post(
  '/admin/login',
  authLimiter,
  validate({ body: z.object({ email: z.string().email(), password: z.string().min(1).max(128) }) }),
  ctrl.adminLogin,
);

router.post('/refresh', ctrl.refresh);
router.post('/logout', ctrl.logout);

// Reset with a one-time recovery code (captcha proves human; the code proves ownership)
router.post(
  '/reset-password',
  authLimiter,
  validate({
    body: z.object({ identifier, recoveryCode, newPassword: password, ...captchaFields }),
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

// Issue a fresh set of recovery codes (password re-entry required)
router.post(
  '/recovery-codes/regenerate',
  requireAuth,
  validate({ body: z.object({ password: z.string().min(1) }) }),
  ctrl.regenerateRecoveryCodes,
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

// --- multi-account switcher (Gmail-style, requires an active session) --------
const userId = z.string().length(24); // Mongo ObjectId hex

router.get('/accounts', requireAuth, ctrl.listAccounts);

// Add another account: a full login folded into the switcher (rate-limited like login)
router.post(
  '/accounts/add',
  requireAuth,
  authLimiter,
  validate({
    body: z.object({ identifier, password: z.string().min(1).max(128), totp: totp.optional(), ...captchaFields }),
  }),
  ctrl.addAccount,
);

// Create a brand-new account and fold it into the switcher (Gmail "create account")
router.post(
  '/accounts/register',
  requireAuth,
  authLimiter,
  validate({ body: z.object(registerFields) }),
  ctrl.registerAccount,
);

router.post(
  '/accounts/switch',
  requireAuth,
  validate({ body: z.object({ userId }) }),
  ctrl.switchAccount,
);

router.post(
  '/accounts/remove',
  requireAuth,
  validate({ body: z.object({ userId }) }),
  ctrl.removeAccount,
);

router.post('/accounts/logout-others', requireAuth, ctrl.logoutOtherAccounts);

export default router;
