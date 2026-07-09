// AuthService (SPEC §2.1) — registration, login, password + security question,
// TOTP 2FA (Google Authenticator), withdrawal PIN. Captcha guards register,
// login, and password reset; cookies/sessions come from token.service.

import { createHash, timingSafeEqual } from 'node:crypto';
import { generateSecret as generateTotpSecret, verify as verifyTotp, generateURI as totpUri } from 'otplib';
import QRCode from 'qrcode';
import { User } from '../models/User.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePhone } from '../utils/phone.js';
import { hashValue, compareValue } from '../utils/hash.js';
import { generateUniqueReferralCode } from '../utils/referralCode.js';
import { generateRecoveryCodes, hashRecoveryCode } from '../utils/recoveryCodes.js';
import * as captchaService from './captcha.service.js';
import * as tokenService from './token.service.js';
import * as walletService from './wallet.service.js';
import * as referralService from './referral.service.js';
import * as notificationService from './notification.service.js';
import * as auditService from './audit.service.js';
import * as spinService from './spin.service.js';

const AUTH_FAILED = () => ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');

// Timing decoy for the "no such account" path. bcrypt is deliberately slow, so
// skipping the compare when a user isn't found returns measurably faster than a
// wrong-password response — an attacker can use that gap to enumerate valid
// identifiers. We run one real bcrypt compare against a throwaway hash instead,
// so both paths spend the same CPU. The hash is computed once via hashValue, so
// it always matches the configured BCRYPT_ROUNDS (a hardcoded constant would
// drift if the cost factor were raised). The plaintext is arbitrary and unused.
let decoyHashPromise;
function equalizeAuthTiming(input) {
  if (!decoyHashPromise) decoyHashPromise = hashValue('timing-decoy-not-a-real-credential');
  return decoyHashPromise.then((hash) => compareValue(input, hash));
}

// Constant-time string equality (sha256 → fixed length so timingSafeEqual never
// throws on length mismatch and no length is leaked). For the env admin creds.
function constantTimeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * otplib v13: verify() resolves { valid } and by default rejects any code not
 * from the current 30s step. 60s of epoch tolerance accepts recent adjacent
 * steps — covers device clock drift and slow form submissions.
 */
async function checkTotp(token, secret) {
  if (!token || !secret) return false;
  try {
    const result = await verifyTotp({ token: String(token), secret, epochTolerance: 60 });
    return result.valid === true;
  } catch {
    return false; // malformed token/secret counts as a failed check, not a 500
  }
}

/** Public shape — never leaks hashes/secrets. */
export function toSafeUser(user) {
  return {
    id: user.id,
    phone: user.phone.e164,
    email: user.email,
    username: user.username ?? null,
    fullName: user.fullName ?? null,
    role: user.role,
    status: user.status,
    kycStatus: user.kyc?.status,
    referralCode: user.referralCode,
    spinCredits: user.spinCredits ?? 0,
    twoFactorEnabled: user.twoFactor?.enabled ?? false,
    hasWithdrawalPin: Boolean(user.withdrawalPinHash),
    createdAt: user.createdAt,
  };
}

/** Find by email, phone, or username. Returns null (not an error) so callers can fail uniformly. */
async function findByIdentifier(identifier, selectExtra = '') {
  const id = String(identifier ?? '').trim();
  let query;
  if (id.includes('@')) {
    query = { email: id.toLowerCase() };
  } else {
    try {
      query = { 'phone.e164': parsePhone(id).e164 };
    } catch {
      if (!/^[a-zA-Z0-9_]{3,30}$/.test(id)) return null;
      query = { username: id.toLowerCase() };
    }
  }
  return User.findOne(query).select(selectExtra);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function register({
  phone,
  email,
  username,
  fullName,
  password,
  referralCode,
  captchaId,
  captchaAnswer,
  meta = {},
}) {
  await captchaService.verifyAndConsume(captchaId, captchaAnswer, 'register');

  const parsedPhone = parsePhone(phone);
  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedUsername = username ? String(username).trim().toLowerCase() : undefined;

  const existing = await User.findOne({
    $or: [
      { 'phone.e164': parsedPhone.e164 },
      { email: normalizedEmail },
      ...(normalizedUsername ? [{ username: normalizedUsername }] : []),
    ],
  });
  if (existing) {
    throw ApiError.conflict(
      'An account with that phone, email, or username already exists',
      'ACCOUNT_EXISTS',
    );
  }

  const { referredBy, uplines } = await referralService.resolveReferrer(referralCode);

  // One-time recovery codes for password reset — the plaintext set is shown to
  // the user exactly once (returned here); only hashes are stored.
  const { plain: recoveryCodes, stored: recoveryCodeHashes } = generateRecoveryCodes();

  const user = await User.create({
    phone: parsedPhone,
    email: normalizedEmail,
    username: normalizedUsername,
    fullName: fullName ? String(fullName).trim() : undefined,
    passwordHash: await hashValue(password),
    recoveryCodes: recoveryCodeHashes,
    referralCode: await generateUniqueReferralCode(User),
    referredBy,
    uplines,
    knownDevices: [{ ip: meta.ip, userAgent: meta.userAgent }],
    lastLoginAt: new Date(),
  });

  await walletService.createWalletsForUser(user._id);

  // Direct (L1) referral reward: the referrer earns spin credit(s) on the wheel
  if (referredBy) await spinService.awardReferralSpin(referredBy, user);

  const accessToken = await tokenService.signAccessToken(user);
  const { refreshToken } = await tokenService.createSession(user, meta);
  return { user: toSafeUser(user), recoveryCodes, accessToken, refreshToken };
}

// ---------------------------------------------------------------------------
// Login / logout / refresh
// ---------------------------------------------------------------------------

export async function login({ identifier, password, captchaId, captchaAnswer, totp, meta = {} }) {
  await captchaService.verifyAndConsume(captchaId, captchaAnswer, 'login');

  const user = await findByIdentifier(identifier, '+passwordHash +twoFactor.secret +knownDevices');
  if (!user) {
    await equalizeAuthTiming(password); // decoy compare — no user-enumeration timing oracle
    throw AUTH_FAILED();
  }
  if (!(await compareValue(password, user.passwordHash))) throw AUTH_FAILED();

  if (user.twoFactor.enabled) {
    // First step passed but no TOTP yet — tell the frontend to show the 2FA screen
    if (!totp) return { requiresTotp: true };
    if (!(await checkTotp(totp, user.twoFactor.secret))) {
      throw ApiError.unauthorized('Invalid authenticator code', 'INVALID_TOTP');
    }
  }

  // Login alert on unknown device/IP (frozen users may still log in — SPEC §2.1)
  const known = user.knownDevices.some(
    (d) => d.ip === meta.ip && d.userAgent === meta.userAgent,
  );
  if (!known) {
    user.knownDevices.push({ ip: meta.ip, userAgent: meta.userAgent });
    if (user.knownDevices.length > 20) user.knownDevices.shift(); // cap the list
    // Best-effort: a failing notification provider must not 500 a valid login
    try {
      await notificationService.notifyUser(user._id, {
        type: 'login_alert',
        title: 'New login to your account',
        body: `A login from a new device or location was detected${meta.ip ? ` (IP ${meta.ip})` : ''}. If this wasn't you, change your password immediately.`,
        meta: { ip: meta.ip, userAgent: meta.userAgent },
      });
    } catch (err) {
      logger.warn({ err, userId: String(user._id) }, 'login_alert notification failed');
    }
    // TODO(email): send the same alert by email once an email provider is wired up
  } else {
    const device = user.knownDevices.find((d) => d.ip === meta.ip && d.userAgent === meta.userAgent);
    device.lastSeenAt = new Date();
  }
  user.lastLoginAt = new Date();
  await user.save();

  const accessToken = await tokenService.signAccessToken(user);
  const { refreshToken } = await tokenService.createSession(user, meta);
  return { user: toSafeUser(user), accessToken, refreshToken };
}

// ---------------------------------------------------------------------------
// Admin login (env-bootstrapped superadmin) — no captcha, no registration.
// Credentials live in ADMIN_EMAIL/ADMIN_PASSWORD (env is the source of truth,
// checked on every login). The backing User row is created on first successful
// login so JWT sub, RBAC, audit, and impersonation all have a real actor.
// ---------------------------------------------------------------------------

/** Create the bootstrap superadmin the first time correct env creds are used. */
async function createBootstrapAdmin(meta = {}) {
  const parsedPhone = parsePhone(env.ADMIN_PHONE);
  const admin = await User.create({
    phone: parsedPhone,
    email: env.ADMIN_EMAIL.toLowerCase(),
    fullName: 'Administrator',
    passwordHash: await hashValue(env.ADMIN_PASSWORD),
    // No recovery codes — the admin authenticates from env creds, not the reset flow
    role: 'superadmin',
    referralCode: await generateUniqueReferralCode(User),
    knownDevices: [{ ip: meta.ip, userAgent: meta.userAgent }],
    lastLoginAt: new Date(),
  });
  await walletService.createWalletsForUser(admin._id);
  logger.info({ adminId: String(admin._id) }, 'bootstrap admin created from env credentials');
  return admin;
}

export async function adminLogin({ email, password, meta = {} }) {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD || !env.ADMIN_PHONE) {
    throw new ApiError(503, 'Admin login is not configured on this server', 'ADMIN_NOT_CONFIGURED');
  }

  // Both checks always run (no early return) so a wrong email and a wrong
  // password are indistinguishable by timing.
  const emailOk = constantTimeEqual(String(email ?? '').trim().toLowerCase(), env.ADMIN_EMAIL.toLowerCase());
  const passwordOk = constantTimeEqual(String(password ?? ''), env.ADMIN_PASSWORD);
  if (!emailOk || !passwordOk) {
    // TEMP DIAGNOSTIC — logs no secret values, only lengths + which side failed.
    // Remove once the admin login issue is resolved.
    logger.warn(
      {
        emailOk,
        passwordOk,
        received: { emailLen: String(email ?? '').length, passwordLen: String(password ?? '').length },
        env: { emailLen: env.ADMIN_EMAIL.length, passwordLen: env.ADMIN_PASSWORD.length },
      },
      'admin login rejected'
    );
    throw AUTH_FAILED();
  }

  let admin = await User.findOne({ email: env.ADMIN_EMAIL.toLowerCase() });
  if (!admin) admin = await createBootstrapAdmin(meta);

  if (admin.status === 'frozen') {
    throw ApiError.forbidden('Admin account is suspended', 'ADMIN_SUSPENDED');
  }
  // Ensure the row carries admin powers (e.g. if it predates this flow / was demoted)
  if (admin.role !== 'admin' && admin.role !== 'superadmin') admin.role = 'superadmin';
  admin.lastLoginAt = new Date();
  await admin.save();

  const accessToken = await tokenService.signAccessToken(admin);
  const { refreshToken } = await tokenService.createSession(admin, meta);
  return { user: toSafeUser(admin), accessToken, refreshToken };
}

export async function refresh(refreshToken, meta = {}) {
  if (!refreshToken) throw ApiError.unauthorized('Missing refresh token', 'INVALID_REFRESH');
  const { refreshToken: nextRefreshToken, session } = await tokenService.rotateSession(refreshToken, meta);
  const user = await User.findById(session.user);
  if (!user) throw ApiError.unauthorized('Account no longer exists', 'USER_GONE');
  const accessToken = await tokenService.signAccessToken(user);
  return { user: toSafeUser(user), accessToken, refreshToken: nextRefreshToken };
}

export async function logout(refreshToken) {
  await tokenService.revokeSession(refreshToken);
}

// ---------------------------------------------------------------------------
// Password + recovery codes (reset flow is captcha + a one-time recovery code)
// ---------------------------------------------------------------------------

export async function resetPassword({ identifier, recoveryCode, newPassword, captchaId, captchaAnswer }) {
  await captchaService.verifyAndConsume(captchaId, captchaAnswer, 'password_reset');

  const user = await findByIdentifier(identifier, '+recoveryCodes');
  // Uniform failure whether the account or the code is wrong — no oracle. The
  // code is a fast sha256 compare, so unknown-account timing isn't a signal.
  const codeHash = hashRecoveryCode(recoveryCode);
  const entry = user?.recoveryCodes?.find((c) => c.codeHash === codeHash && !c.usedAt);
  if (!user || !entry) throw ApiError.badRequest('Password reset failed', 'RESET_FAILED');

  entry.usedAt = new Date(); // one-time: burn the code
  user.passwordHash = await hashValue(newPassword);
  await user.save();
  await tokenService.revokeAllForUser(user._id); // force re-login everywhere

  return { recoveryCodesRemaining: user.recoveryCodes.filter((c) => !c.usedAt).length };
}

/** Issue a fresh set of recovery codes (password re-entry required). Invalidates the old set. */
export async function regenerateRecoveryCodes(user, { password }) {
  const withHash = await User.findById(user._id).select('+passwordHash');
  if (!(await compareValue(password, withHash.passwordHash))) {
    throw ApiError.badRequest('Password is incorrect', 'WRONG_PASSWORD');
  }
  const { plain, stored } = generateRecoveryCodes();
  withHash.recoveryCodes = stored;
  await withHash.save();
  return { recoveryCodes: plain };
}

export async function changePassword(user, { currentPassword, newPassword }) {
  const withHash = await User.findById(user._id).select('+passwordHash');
  if (!(await compareValue(currentPassword, withHash.passwordHash))) {
    throw ApiError.badRequest('Current password is incorrect', 'WRONG_PASSWORD');
  }
  withHash.passwordHash = await hashValue(newPassword);
  await withHash.save();
  await tokenService.revokeAllForUser(user._id);
}

// ---------------------------------------------------------------------------
// TOTP 2FA (Google Authenticator)
// ---------------------------------------------------------------------------

export async function enable2fa(user) {
  if (user.twoFactor?.enabled) throw ApiError.conflict('2FA is already enabled', '2FA_ALREADY_ON');
  const secret = generateTotpSecret();
  await User.updateOne({ _id: user._id }, { $set: { 'twoFactor.secret': secret, 'twoFactor.enabled': false } });
  const otpauthUrl = totpUri({ secret, issuer: 'Market-Side', label: user.email });
  const qr = await QRCode.toDataURL(otpauthUrl);
  return { secret, otpauthUrl, qr }; // user scans qr, then calls confirm2fa
}

export async function confirm2fa(user, totp) {
  const withSecret = await User.findById(user._id).select('+twoFactor.secret');
  if (!withSecret.twoFactor.secret) throw ApiError.badRequest('2FA setup not started', '2FA_NOT_STARTED');
  if (!(await checkTotp(totp, withSecret.twoFactor.secret))) {
    throw ApiError.badRequest('Invalid authenticator code', 'INVALID_TOTP');
  }
  withSecret.twoFactor.enabled = true;
  await withSecret.save();
}

export async function disable2fa(user, totp) {
  const withSecret = await User.findById(user._id).select('+twoFactor.secret');
  if (!withSecret.twoFactor.enabled) throw ApiError.badRequest('2FA is not enabled', '2FA_NOT_ON');
  if (!(await checkTotp(totp, withSecret.twoFactor.secret))) {
    throw ApiError.badRequest('Invalid authenticator code', 'INVALID_TOTP');
  }
  withSecret.twoFactor = { enabled: false, secret: null };
  await withSecret.save();
}

// ---------------------------------------------------------------------------
// Withdrawal PIN — set/change guarded by TOTP when 2FA is on, else password
// ---------------------------------------------------------------------------

export async function setWithdrawalPin(user, { pin, totp, password }) {
  if (!/^\d{4,6}$/.test(String(pin))) {
    throw ApiError.badRequest('PIN must be 4–6 digits', 'INVALID_PIN_FORMAT');
  }

  const withSecrets = await User.findById(user._id).select('+passwordHash +twoFactor.secret');
  if (withSecrets.twoFactor.enabled) {
    if (!(await checkTotp(totp, withSecrets.twoFactor.secret))) {
      throw ApiError.badRequest('Valid authenticator code required', 'INVALID_TOTP');
    }
  } else if (!password || !(await compareValue(password, withSecrets.passwordHash))) {
    throw ApiError.badRequest('Password is incorrect', 'WRONG_PASSWORD');
  }

  withSecrets.withdrawalPinHash = await hashValue(String(pin));
  await withSecrets.save();
}

/** Sensitive-action gate (e.g. withdrawals): when 2FA is on, a valid TOTP is mandatory. */
export async function requireTotpIfEnabled(user, totp) {
  const withSecret = await User.findById(user._id ?? user).select('+twoFactor.secret');
  if (!withSecret?.twoFactor?.enabled) return;
  if (!(await checkTotp(totp, withSecret.twoFactor.secret))) {
    throw ApiError.badRequest('Valid authenticator code required', 'INVALID_TOTP');
  }
}

// ---------------------------------------------------------------------------
// Impersonation (SPEC §2.11 admin support tool) — the admin browses AS a user.
// A short-lived access token authenticates as the target but carries the
// admin's id in `imp`; only the access cookie changes, so the admin's refresh
// session survives and exit (or any token refresh) restores the admin. While
// the claim is present, requireRole blocks every admin route.
// ---------------------------------------------------------------------------

export async function impersonate(admin, targetUserId, { reason, ip, userAgent } = {}) {
  if (String(admin._id) === String(targetUserId)) {
    throw ApiError.badRequest('You are already logged in as this user', 'IMPERSONATE_SELF');
  }
  const target = await User.findById(targetUserId);
  if (!target) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');
  // Same rule as freeze/unfreeze: staff accounts are superadmin-only targets
  if (target.role !== 'user' && admin.role !== 'superadmin') {
    throw ApiError.forbidden('Only a superadmin can impersonate a staff account', 'FORBIDDEN_TARGET');
  }

  const accessToken = await tokenService.signImpersonationToken(target, admin);
  await auditService.record({
    actor: admin,
    action: 'user.impersonate',
    target: { kind: 'User', item: target._id },
    meta: { reason },
    ip,
    userAgent,
  });
  return { accessToken, user: toSafeUser(target) };
}

/** Restore the admin's own session from the token's `imp` claim. */
export async function exitImpersonation(adminId, { ip, userAgent } = {}) {
  const admin = await User.findById(adminId);
  if (!admin || !['admin', 'superadmin'].includes(admin.role) || admin.status !== 'active') {
    throw ApiError.unauthorized('Admin account is no longer available', 'ADMIN_UNAVAILABLE');
  }
  const accessToken = await tokenService.signAccessToken(admin);
  await auditService.record({ actor: admin, action: 'user.impersonate.exit', ip, userAgent });
  return { accessToken, user: toSafeUser(admin) };
}

export async function verifyWithdrawalPin(user, pin) {
  const withPin = await User.findById(user._id).select('+withdrawalPinHash');
  if (!withPin.withdrawalPinHash) {
    throw ApiError.badRequest('Set a withdrawal PIN first', 'PIN_NOT_SET');
  }
  if (!(await compareValue(String(pin), withPin.withdrawalPinHash))) {
    throw ApiError.badRequest('Incorrect withdrawal PIN', 'WRONG_PIN');
  }
}
