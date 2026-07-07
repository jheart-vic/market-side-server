// AuthService (SPEC §2.1) — registration, login, password + security question,
// TOTP 2FA (Google Authenticator), withdrawal PIN. Captcha guards register,
// login, and password reset; cookies/sessions come from token.service.

import { generateSecret as generateTotpSecret, verify as verifyTotp, generateURI as totpUri } from 'otplib';
import QRCode from 'qrcode';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePhone } from '../utils/phone.js';
import { hashValue, compareValue, normalizeSecurityAnswer } from '../utils/hash.js';
import { generateUniqueReferralCode } from '../utils/referralCode.js';
import { getQuestionById } from '../config/securityQuestions.js';
import * as captchaService from './captcha.service.js';
import * as tokenService from './token.service.js';
import * as walletService from './wallet.service.js';
import * as referralService from './referral.service.js';
import * as notificationService from './notification.service.js';
import * as auditService from './audit.service.js';
import * as spinService from './spin.service.js';

const AUTH_FAILED = () => ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');

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
  securityQuestionId,
  securityAnswer,
  captchaId,
  captchaAnswer,
  meta = {},
}) {
  await captchaService.verifyAndConsume(captchaId, captchaAnswer, 'register');

  // The question must come from the predefined list — users don't invent one
  const securityQuestion = getQuestionById(securityQuestionId);
  if (!securityQuestion) {
    throw ApiError.badRequest('Unknown security question', 'INVALID_SECURITY_QUESTION');
  }

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

  const user = await User.create({
    phone: parsedPhone,
    email: normalizedEmail,
    username: normalizedUsername,
    fullName: fullName ? String(fullName).trim() : undefined,
    passwordHash: await hashValue(password),
    security: {
      questionId: securityQuestion.id,
      question: securityQuestion.question,
      answerHash: await hashValue(normalizeSecurityAnswer(securityAnswer)),
    },
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
  return { user: toSafeUser(user), accessToken, refreshToken };
}

// ---------------------------------------------------------------------------
// Login / logout / refresh
// ---------------------------------------------------------------------------

export async function login({ identifier, password, captchaId, captchaAnswer, totp, meta = {} }) {
  await captchaService.verifyAndConsume(captchaId, captchaAnswer, 'login');

  const user = await findByIdentifier(identifier, '+passwordHash +twoFactor.secret +knownDevices');
  if (!user) throw AUTH_FAILED();
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
    await notificationService.notifyUser(user._id, {
      type: 'login_alert',
      title: 'New login to your account',
      body: `A login from a new device or location was detected${meta.ip ? ` (IP ${meta.ip})` : ''}. If this wasn't you, change your password immediately.`,
      meta: { ip: meta.ip, userAgent: meta.userAgent },
    });
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
// Password + security question (reset flow is captcha + security answer)
// ---------------------------------------------------------------------------

export async function getSecurityQuestion(identifier) {
  const user = await findByIdentifier(identifier);
  if (!user) throw ApiError.notFound('No account matches that phone/email', 'ACCOUNT_NOT_FOUND');
  return { question: user.security.question };
}

export async function resetPassword({ identifier, answer, newPassword, captchaId, captchaAnswer }) {
  await captchaService.verifyAndConsume(captchaId, captchaAnswer, 'password_reset');

  const user = await findByIdentifier(identifier, '+security.answerHash');
  if (!user) throw ApiError.badRequest('Password reset failed', 'RESET_FAILED');
  if (!(await compareValue(normalizeSecurityAnswer(answer), user.security.answerHash))) {
    throw ApiError.badRequest('Password reset failed', 'RESET_FAILED'); // same error — no oracle
  }

  user.passwordHash = await hashValue(newPassword);
  await user.save();
  await tokenService.revokeAllForUser(user._id); // force re-login everywhere
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

export async function changeSecurityQuestion(user, { password, questionId, answer }) {
  const question = getQuestionById(questionId);
  if (!question) throw ApiError.badRequest('Unknown security question', 'INVALID_SECURITY_QUESTION');

  const withHash = await User.findById(user._id).select('+passwordHash');
  if (!(await compareValue(password, withHash.passwordHash))) {
    throw ApiError.badRequest('Password is incorrect', 'WRONG_PASSWORD');
  }
  withHash.security = {
    questionId: question.id,
    question: question.question,
    answerHash: await hashValue(normalizeSecurityAnswer(answer)),
  };
  await withHash.save();
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
