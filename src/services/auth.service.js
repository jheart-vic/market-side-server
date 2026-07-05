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
import * as captchaService from './captcha.service.js';
import * as tokenService from './token.service.js';
import * as walletService from './wallet.service.js';
import * as referralService from './referral.service.js';
import * as notificationService from './notification.service.js';

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
    role: user.role,
    status: user.status,
    kycStatus: user.kyc?.status,
    referralCode: user.referralCode,
    twoFactorEnabled: user.twoFactor?.enabled ?? false,
    hasWithdrawalPin: Boolean(user.withdrawalPinHash),
    createdAt: user.createdAt,
  };
}

/** Find by email or phone. Returns null (not an error) so callers can fail uniformly. */
async function findByIdentifier(identifier, selectExtra = '') {
  const id = String(identifier ?? '').trim();
  let query;
  if (id.includes('@')) {
    query = { email: id.toLowerCase() };
  } else {
    try {
      query = { 'phone.e164': parsePhone(id).e164 };
    } catch {
      return null;
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
  password,
  referralCode,
  securityQuestion,
  securityAnswer,
  captchaId,
  captchaAnswer,
  meta = {},
}) {
  await captchaService.verifyAndConsume(captchaId, captchaAnswer, 'register');

  const parsedPhone = parsePhone(phone);
  const normalizedEmail = String(email).trim().toLowerCase();

  const existing = await User.findOne({
    $or: [{ 'phone.e164': parsedPhone.e164 }, { email: normalizedEmail }],
  });
  if (existing) throw ApiError.conflict('An account with that phone or email already exists', 'ACCOUNT_EXISTS');

  const { referredBy, uplines } = await referralService.resolveReferrer(referralCode);

  const user = await User.create({
    phone: parsedPhone,
    email: normalizedEmail,
    passwordHash: await hashValue(password),
    security: {
      question: String(securityQuestion).trim(),
      answerHash: await hashValue(normalizeSecurityAnswer(securityAnswer)),
    },
    referralCode: await generateUniqueReferralCode(User),
    referredBy,
    uplines,
    knownDevices: [{ ip: meta.ip, userAgent: meta.userAgent }],
    lastLoginAt: new Date(),
  });

  await walletService.createWalletsForUser(user._id);

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

export async function changeSecurityQuestion(user, { password, question, answer }) {
  const withHash = await User.findById(user._id).select('+passwordHash');
  if (!(await compareValue(password, withHash.passwordHash))) {
    throw ApiError.badRequest('Password is incorrect', 'WRONG_PASSWORD');
  }
  withHash.security = {
    question: String(question).trim(),
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

export async function verifyWithdrawalPin(user, pin) {
  const withPin = await User.findById(user._id).select('+withdrawalPinHash');
  if (!withPin.withdrawalPinHash) {
    throw ApiError.badRequest('Set a withdrawal PIN first', 'PIN_NOT_SET');
  }
  if (!(await compareValue(String(pin), withPin.withdrawalPinHash))) {
    throw ApiError.badRequest('Incorrect withdrawal PIN', 'WRONG_PIN');
  }
}
