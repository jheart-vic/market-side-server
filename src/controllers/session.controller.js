import * as sessionService from '../services/session.service.js';
import { COOKIES } from '../config/constants.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// The caller's own session is identified by its refresh cookie (hashed to match
// Session.refreshTokenHash) — the access JWT carries no session id.
const currentRefresh = (req) => req.cookies?.[COOKIES.refresh];

export const list = asyncHandler(async (req, res) => {
  const sessions = await sessionService.listSessions(req.user._id, currentRefresh(req));
  res.json({ success: true, sessions });
});

export const revoke = asyncHandler(async (req, res) => {
  const result = await sessionService.revokeSession(req.user._id, req.validated.params.id, currentRefresh(req));
  res.json({ success: true, ...result });
});

export const revokeOthers = asyncHandler(async (req, res) => {
  const result = await sessionService.revokeOtherSessions(req.user._id, currentRefresh(req));
  res.json({ success: true, ...result });
});
