import rateLimit from 'express-rate-limit';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';

// SPEC §2.12: rate limiting, stricter on auth/captcha routes.

const disabled = env.NODE_ENV === 'test';

function makeLimiter({ windowMs, max, code }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => disabled,
    handler: (req, res, next) => next(ApiError.tooMany('Too many requests, slow down', code)),
  });
}

/** Whole-API baseline (mounted in app.js). */
export const generalLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 300,
  code: 'RATE_LIMITED',
});

/** Login / register / password reset — brute-force surface. */
export const authLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  code: 'AUTH_RATE_LIMITED',
});

/** Captcha issue/verify — cheap to farm, so tighter than general but looser than auth submits. */
export const captchaLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  code: 'CAPTCHA_RATE_LIMITED',
});

/** Money movement (withdrawals, conversions, signal joins) — abuse/velocity brake. */
export const transactionLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 20,
  code: 'TX_RATE_LIMITED',
});
