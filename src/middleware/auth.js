import { jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { COOKIES } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { User } from '../models/User.js';

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

async function resolveUser(req) {
  const token = req.cookies?.[COOKIES.access];
  if (!token) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(token, accessSecret));
  } catch {
    throw ApiError.unauthorized('Session expired or invalid', 'INVALID_TOKEN');
  }
  // +withdrawalPinHash (select:false) so toSafeUser can expose the
  // `hasWithdrawalPin` boolean — without it the flag is always false and the
  // app keeps asking the user to set a PIN they already have. Only the boolean
  // is ever serialized; the hash itself never leaves the server.
  const user = await User.findById(payload.sub).select('+withdrawalPinHash');
  if (!user) throw ApiError.unauthorized('Account no longer exists', 'USER_GONE');
  // Impersonation token (admin support tool): the admin's id rides in `imp`.
  // Handlers can tell a real session from an impersonated one via this flag.
  req.impersonatedBy = payload.imp ?? null;
  return user;
}

/** Requires a valid access-token cookie; attaches the user doc as req.user. */
export const requireAuth = asyncHandler(async (req, res, next) => {
  const user = await resolveUser(req);
  if (!user) throw ApiError.unauthorized();
  req.user = user;
  next();
});

/** Attaches req.user when a valid cookie is present, but never rejects (public routes with personalization). */
export const optionalAuth = asyncHandler(async (req, res, next) => {
  try {
    req.user = await resolveUser(req);
  } catch {
    req.user = null;
  }
  next();
});

/**
 * Frozen users can log in and view, but cannot transact (SPEC §2.1).
 * Mount after requireAuth on deposit/withdraw/trade/convert/signal routes.
 */
export function requireActive(req, res, next) {
  if (!req.user) return next(ApiError.unauthorized());
  if (req.user.status !== 'active') {
    return next(ApiError.forbidden('Account is frozen — transactions are disabled', 'ACCOUNT_FROZEN'));
  }
  return next();
}
