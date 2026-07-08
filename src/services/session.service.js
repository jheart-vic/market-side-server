// SessionService — user-facing view + control over their active login sessions
// (one per device/login). Reads the Session model (token.service owns creation
// and rotation) and lets a user see their devices and log others out.
// Revoking a session invalidates its refresh token immediately; that device's
// short-lived access token still works until it expires (≤ ACCESS_TOKEN_TTL),
// then it can't refresh and is logged out.

import { Session } from '../models/Session.js';
import { sha256 } from '../utils/tokens.js';
import { parseUserAgent } from '../utils/userAgent.js';
import { ApiError } from '../utils/ApiError.js';

function toDisplay(session, currentHash) {
  return {
    id: session.id,
    current: currentHash != null && session.refreshTokenHash === currentHash,
    device: parseUserAgent(session.userAgent),
    ip: session.ip ?? null,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    expiresAt: session.expiresAt,
  };
}

/** Active (non-revoked, non-expired) sessions, most-recently-used first. */
export async function listSessions(userId, currentRefreshToken) {
  const currentHash = currentRefreshToken ? sha256(currentRefreshToken) : null;
  const sessions = await Session.find({
    user: userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ lastUsedAt: -1 });
  return sessions.map((s) => toDisplay(s, currentHash));
}

/** Revoke one of the caller's sessions (log out that device). */
export async function revokeSession(userId, sessionId, currentRefreshToken) {
  const session = await Session.findOne({ _id: sessionId, user: userId }).catch(() => null);
  if (!session) throw ApiError.notFound('Session not found', 'SESSION_NOT_FOUND');

  const currentHash = currentRefreshToken ? sha256(currentRefreshToken) : null;
  const wasCurrent = currentHash != null && session.refreshTokenHash === currentHash;
  if (!session.revokedAt) {
    session.revokedAt = new Date();
    await session.save();
  }
  return { revoked: true, wasCurrent };
}

/** Log out every other device — revoke all the caller's sessions except this one. */
export async function revokeOtherSessions(userId, currentRefreshToken) {
  const currentHash = currentRefreshToken ? sha256(currentRefreshToken) : null;
  const filter = { user: userId, revokedAt: null };
  if (currentHash) filter.refreshTokenHash = { $ne: currentHash };
  const result = await Session.updateMany(filter, { $set: { revokedAt: new Date() } });
  return { revokedCount: result.modifiedCount ?? 0 };
}
