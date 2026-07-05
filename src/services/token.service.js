// TokenService — access JWT (jose) + rotating refresh sessions (Session model).
// Refresh tokens are opaque randoms stored hashed; rotation keeps the previous
// hash so reuse of a rotated token is detected and the whole session revoked.
// Cookies are set only via utils/cookies.js helpers.

import { SignJWT } from 'jose';
import { Session } from '../models/Session.js';
import { env } from '../config/env.js';
import { COOKIES } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { randomToken, sha256 } from '../utils/tokens.js';
import { accessCookieOptions, refreshCookieOptions, baseCookieOptions, csrfCookieOptions } from '../utils/cookies.js';
import { issueCsrfCookie } from '../middleware/csrf.js';

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

const TTL_UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function accessTtlMs() {
  const match = /^(\d+)([smhd])$/.exec(env.ACCESS_TOKEN_TTL);
  if (!match) throw new Error(`Invalid ACCESS_TOKEN_TTL: ${env.ACCESS_TOKEN_TTL}`);
  return Number(match[1]) * TTL_UNIT_MS[match[2]];
}

export async function signAccessToken(user) {
  return new SignJWT({ role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(env.ACCESS_TOKEN_TTL)
    .sign(accessSecret);
}

export async function createSession(user, { ip, userAgent } = {}) {
  const refreshToken = randomToken(48);
  const session = await Session.create({
    user: user._id,
    refreshTokenHash: sha256(refreshToken),
    ip,
    userAgent,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * TTL_UNIT_MS.d),
  });
  return { refreshToken, session };
}

/**
 * Exchange a refresh token for a new one (rotation). If the presented token
 * matches a session's *previous* hash, someone is replaying a rotated token —
 * revoke the session entirely.
 */
export async function rotateSession(refreshToken, { ip, userAgent } = {}) {
  const hash = sha256(refreshToken);
  const now = new Date();

  const session = await Session.findOne({ refreshTokenHash: hash, revokedAt: null, expiresAt: { $gt: now } });
  if (!session) {
    const replayed = await Session.findOne({ previousTokenHash: hash, revokedAt: null });
    if (replayed) {
      replayed.revokedAt = now;
      await replayed.save();
    }
    throw ApiError.unauthorized('Invalid refresh token', 'INVALID_REFRESH');
  }

  const nextToken = randomToken(48);
  session.previousTokenHash = session.refreshTokenHash;
  session.refreshTokenHash = sha256(nextToken);
  session.lastUsedAt = now;
  session.ip = ip ?? session.ip;
  session.userAgent = userAgent ?? session.userAgent;
  await session.save();

  return { refreshToken: nextToken, session };
}

export async function revokeSession(refreshToken) {
  if (!refreshToken) return;
  await Session.updateOne(
    { refreshTokenHash: sha256(refreshToken), revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

/** Kill every session (password reset/change — force re-login everywhere). */
export async function revokeAllForUser(userId) {
  await Session.updateMany({ user: userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(COOKIES.access, accessToken, accessCookieOptions(accessTtlMs()));
  res.cookie(COOKIES.refresh, refreshToken, refreshCookieOptions());
  issueCsrfCookie(res);
}

export function clearAuthCookies(res) {
  const base = baseCookieOptions();
  res.clearCookie(COOKIES.access, base);
  res.clearCookie(COOKIES.refresh, base);
  res.clearCookie(COOKIES.csrf, csrfCookieOptions());
}
