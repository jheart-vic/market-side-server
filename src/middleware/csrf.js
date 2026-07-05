import crypto from 'node:crypto';
import { COOKIES, CSRF_HEADER } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { csrfCookieOptions } from '../utils/cookies.js';

// Double-submit CSRF (SPEC §2.1): the csrf cookie is readable JS-side; the
// frontend echoes it in the x-csrf-token header on every mutating request.
// Cookie-less requests (gateway webhooks, pre-login calls) have no session to
// ride, so the check only applies when an access cookie is present.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.cookies?.[COOKIES.access]) return next();

  const cookieToken = req.cookies?.[COOKIES.csrf];
  const headerToken = req.get(CSRF_HEADER);
  if (!cookieToken || !headerToken || !timingSafeEqual(cookieToken, headerToken)) {
    return next(ApiError.forbidden('CSRF token missing or invalid', 'CSRF_FAILED'));
  }
  return next();
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Issue/refresh the csrf cookie — call from the auth service on login/refresh. */
export function issueCsrfCookie(res) {
  const token = crypto.randomBytes(24).toString('hex');
  res.cookie(COOKIES.csrf, token, csrfCookieOptions());
  return token;
}
