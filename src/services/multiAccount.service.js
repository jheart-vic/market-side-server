// MultiAccountService — Gmail-style multi-account switching on one browser.
//
// The ACTIVE account keeps using ms_access / ms_refresh / ms_csrf exactly as a
// single-account session does, so every existing route, the refresh rotation,
// CSRF, and impersonation are untouched. The only new state is one signed,
// httpOnly `ms_accounts` cookie holding the OTHER (inactive) linked accounts —
// each as { id, rt (its live refresh token), label } — plus the active id.
//
// Switching = move the currently-active account into the linked list, rotate the
// target's session, and promote it into the active cookies. Adding = a full
// login (done by the controller) whose result is folded in here. Because tokens
// live only in httpOnly cookies, all of this is server-mediated — the frontend
// never sees a refresh token.
//
// Accounts signed into the same browser are unioned into a durable link group
// (User.linkGroupId) so the anti-abuse block on cross-account referral/spin
// benefit survives later unlinking.

import mongoose from 'mongoose';
import { SignJWT, jwtVerify } from 'jose';
import { User } from '../models/User.js';
import { Session } from '../models/Session.js';
import { env } from '../config/env.js';
import { COOKIES, MAX_LINKED_ACCOUNTS } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../config/logger.js';
import { sha256 } from '../utils/tokens.js';
import { accountsCookieOptions, baseCookieOptions } from '../utils/cookies.js';
import * as tokenService from './token.service.js';
import * as auditService from './audit.service.js';

const accountsSecret = new TextEncoder().encode(env.MULTI_ACCOUNT_SECRET);
const COOKIE_TTL = `${env.REFRESH_TOKEN_TTL_DAYS}d`;

// --- ms_accounts cookie codec (signed JWT; payload readable only server-side) -

async function signAccountsCookie(payload) {
  return new SignJWT({ linked: payload.linked, active: payload.active })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(COOKIE_TTL)
    .sign(accountsSecret);
}

/** Decode ms_accounts → { active, linked:[{id,rt,label}] } or null if absent/tampered. */
async function readAccounts(req) {
  const raw = req.cookies?.[COOKIES.accounts];
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, accountsSecret);
    return { active: payload.active ?? null, linked: Array.isArray(payload.linked) ? payload.linked : [] };
  } catch {
    return null; // tampered/expired — treat as no linked accounts
  }
}

async function writeAccounts(res, linked, activeId) {
  if (!linked.length) {
    clearAccounts(res);
    return;
  }
  const token = await signAccountsCookie({ active: activeId, linked });
  res.cookie(COOKIES.accounts, token, accountsCookieOptions());
}

function clearAccounts(res) {
  res.clearCookie(COOKIES.accounts, baseCookieOptions());
}

// --- helpers ---------------------------------------------------------------

function labelOf(user) {
  return user.fullName || user.username || user.email || 'Account';
}

/** A cookie entry for the given active user + its current refresh token. */
function entryFor(user, refreshToken) {
  return { id: String(user._id ?? user.id), rt: refreshToken, label: labelOf(user) };
}

/** Is the entry's refresh token still a live (non-revoked, non-expired) session? */
async function isLive(rt) {
  if (!rt) return false;
  const session = await Session.findOne({
    refreshTokenHash: sha256(rt),
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  return Boolean(session);
}

// --- durable link group (union-find over User.linkGroupId) ------------------

/**
 * Union two accounts into one link group. Durable: once linked, the group id
 * persists even if the browser later unlinks them, so cross-benefit blocking
 * can't be evaded. Audited.
 */
export async function linkAccounts(aId, bId, actor) {
  if (String(aId) === String(bId)) return;
  const [a, b] = await Promise.all([
    User.findById(aId).select('linkGroupId'),
    User.findById(bId).select('linkGroupId'),
  ]);
  if (!a || !b) return;

  const ga = a.linkGroupId ? String(a.linkGroupId) : null;
  const gb = b.linkGroupId ? String(b.linkGroupId) : null;

  let groupId;
  if (!ga && !gb) {
    groupId = new mongoose.Types.ObjectId();
    await User.updateMany({ _id: { $in: [a._id, b._id] } }, { $set: { linkGroupId: groupId } });
  } else if (ga && !gb) {
    groupId = a.linkGroupId;
    await User.updateOne({ _id: b._id }, { $set: { linkGroupId: groupId } });
  } else if (!ga && gb) {
    groupId = b.linkGroupId;
    await User.updateOne({ _id: a._id }, { $set: { linkGroupId: groupId } });
  } else if (ga === gb) {
    return; // already same group
  } else {
    // Merge: fold group b into group a across all its members.
    groupId = a.linkGroupId;
    await User.updateMany({ linkGroupId: b.linkGroupId }, { $set: { linkGroupId: groupId } });
  }

  await auditService
    .record({
      actor: actor ?? a._id,
      action: 'account.link',
      target: b._id,
      meta: { groupId: String(groupId), linked: [String(a._id), String(b._id)] },
    })
    .catch((err) => logger.warn({ err }, 'account.link audit failed'));

  return groupId;
}

/** Two users share a durable link group (both non-null and equal). */
export function sameLinkGroup(aGroupId, bGroupId) {
  return Boolean(aGroupId) && Boolean(bGroupId) && String(aGroupId) === String(bGroupId);
}

// --- switcher operations ----------------------------------------------------

/**
 * Build the switcher display array from an active user + linked entries — the
 * active one first. Labels are refreshed from the DB so renames show correctly.
 * Callers pass the linked list they just computed (don't re-read the request
 * cookie, which lags a just-written response cookie).
 */
async function formatList(active, linked) {
  const activeId = String(active._id ?? active.id); // may be a doc or a safe-user
  const ids = linked.map((e) => e.id);
  const fresh = ids.length
    ? await User.find({ _id: { $in: ids } }).select('fullName username email')
    : [];
  const freshById = new Map(fresh.map((u) => [String(u._id), u]));

  const out = [{ id: activeId, label: labelOf(active), active: true }];
  for (const entry of linked) {
    const u = freshById.get(String(entry.id));
    out.push({ id: String(entry.id), label: u ? labelOf(u) : entry.label, active: false });
  }
  return out;
}

/**
 * List accounts for the switcher UI: the active one first, then linked ones.
 * Dead linked sessions are filtered out (and pruned from the cookie).
 */
export async function list(req, res) {
  const active = req.user;
  const activeId = String(active._id ?? active.id);
  const store = await readAccounts(req);
  const linked = store?.linked ?? [];

  // Prune linked entries whose session died; rewrite the cookie if anything changed.
  const alive = [];
  for (const entry of linked) {
    if (String(entry.id) === activeId) continue; // never duplicate the active one
    if (await isLive(entry.rt)) alive.push(entry);
  }
  if (res && alive.length !== linked.length) await writeAccounts(res, alive, activeId);

  return formatList(active, alive);
}

/**
 * Fold a freshly-authenticated login into the switcher (Gmail-style: the new
 * account becomes active). `loginResult` is authService.login's success payload
 * ({ user, accessToken, refreshToken }); the controller has already verified
 * credentials + captcha (+ TOTP).
 */
export async function add(req, res, loginResult) {
  const { user: newUser, accessToken, refreshToken } = loginResult;
  const active = req.user;
  const currentRefresh = req.cookies?.[COOKIES.refresh];

  if (String(newUser.id) === String(active._id)) {
    throw ApiError.badRequest('That account is already the active one', 'ALREADY_ACTIVE');
  }

  const store = await readAccounts(req);
  let linked = (store?.linked ?? []).filter((e) => String(e.id) !== String(active._id));

  // Re-adding an account already in the list: drop (and revoke) its stale entry.
  const existing = linked.find((e) => String(e.id) === String(newUser.id));
  if (existing) {
    await tokenService.revokeSession(existing.rt);
    linked = linked.filter((e) => String(e.id) !== String(newUser.id));
  }

  // Cap counts the active account + the ones parked in the cookie.
  if (1 + linked.length >= MAX_LINKED_ACCOUNTS) {
    throw ApiError.badRequest(
      `You can keep at most ${MAX_LINKED_ACCOUNTS} accounts signed in on one device`,
      'ACCOUNT_LIMIT',
    );
  }

  // Durable anti-abuse linkage between the two accounts.
  await linkAccounts(active._id, newUser.id, active._id);

  // Park the currently-active account (if we can preserve its session), promote the new one.
  if (currentRefresh && (await isLive(currentRefresh))) {
    linked.push(entryFor(active, currentRefresh));
  }
  tokenService.setAuthCookies(res, { accessToken, refreshToken });
  await writeAccounts(res, linked, String(newUser.id));

  return formatList(newUser, linked);
}

/** Switch the active account to `targetId` (must already be linked in this browser). */
export async function switchTo(req, res, targetId) {
  const active = req.user;
  if (String(targetId) === String(active._id)) {
    return { user: active, accounts: await list(req, res) };
  }

  const store = await readAccounts(req);
  let linked = store?.linked ?? [];
  const target = linked.find((e) => String(e.id) === String(targetId));
  if (!target) throw ApiError.notFound('That account is not signed in on this device', 'NOT_LINKED');

  // Rotate the target's session into fresh active tokens.
  let rotated;
  try {
    rotated = await tokenService.rotateSession(target.rt, { ip: req.ip, userAgent: req.get('user-agent') });
  } catch {
    // Its session died — drop it and report.
    linked = linked.filter((e) => String(e.id) !== String(targetId));
    await writeAccounts(res, linked, String(active._id));
    throw ApiError.unauthorized('That account was signed out — please add it again', 'LINK_EXPIRED');
  }

  const targetUser = await User.findById(targetId);
  if (!targetUser) {
    linked = linked.filter((e) => String(e.id) !== String(targetId));
    await writeAccounts(res, linked, String(active._id));
    throw ApiError.unauthorized('Account no longer exists', 'USER_GONE');
  }

  const accessToken = await tokenService.signAccessToken(targetUser);
  tokenService.setAuthCookies(res, { accessToken, refreshToken: rotated.refreshToken });

  // Move the previously-active account into the linked list; remove the target from it.
  const currentRefresh = req.cookies?.[COOKIES.refresh];
  let nextLinked = linked.filter((e) => String(e.id) !== String(targetId));
  if (currentRefresh && (await isLive(currentRefresh))) {
    nextLinked = nextLinked.filter((e) => String(e.id) !== String(active._id));
    nextLinked.push(entryFor(active, currentRefresh));
  }
  await writeAccounts(res, nextLinked, String(targetId));

  return { user: targetUser, accounts: await formatList(targetUser, nextLinked) };
}

/**
 * Remove one account from the switcher. If it's a linked (inactive) account,
 * just revoke + drop it. If it's the active account, this is a "log out active"
 * — promote the next linked account, or fully clear cookies if none remain.
 */
export async function remove(req, res, targetId) {
  const active = req.user;
  if (String(targetId) === String(active._id)) return logoutActive(req, res);

  const store = await readAccounts(req);
  const entry = (store?.linked ?? []).find((e) => String(e.id) === String(targetId));
  if (!entry) throw ApiError.notFound('That account is not signed in on this device', 'NOT_LINKED');

  await tokenService.revokeSession(entry.rt);
  const linked = (store?.linked ?? []).filter((e) => String(e.id) !== String(targetId));
  await writeAccounts(res, linked, String(active._id));
  return { removed: true, accounts: await formatList(active, linked) };
}

/**
 * Default logout: sign out only the ACTIVE account. If other accounts are
 * linked, promote the first to active; otherwise clear everything. Works for
 * single-account users too (no ms_accounts → just clears cookies).
 */
export async function logoutActive(req, res) {
  await tokenService.revokeSession(req.cookies?.[COOKIES.refresh]);

  const store = await readAccounts(req);
  const linked = store?.linked ?? [];

  // Promote the first still-live linked account.
  while (linked.length) {
    const next = linked.shift();
    let rotated;
    try {
      rotated = await tokenService.rotateSession(next.rt, { ip: req.ip, userAgent: req.get('user-agent') });
    } catch {
      continue; // dead session — skip
    }
    const nextUser = await User.findById(next.id);
    if (!nextUser) continue;
    const accessToken = await tokenService.signAccessToken(nextUser);
    tokenService.setAuthCookies(res, { accessToken, refreshToken: rotated.refreshToken });
    await writeAccounts(res, linked, String(nextUser._id));
    return { switched: true, user: nextUser, accounts: await formatList(nextUser, linked) };
  }

  // Nothing left to promote — full logout.
  tokenService.clearAuthCookies(res);
  clearAccounts(res);
  return { loggedOut: true };
}

/** Sign out every OTHER linked account, keeping only the active one. */
export async function logoutOthers(req, res) {
  const store = await readAccounts(req);
  for (const entry of store?.linked ?? []) {
    await tokenService.revokeSession(entry.rt);
  }
  clearAccounts(res);
  return { accounts: await formatList(req.user, []) };
}
