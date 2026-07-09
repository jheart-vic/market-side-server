// CaptchaService (SPEC §2.1) — svg-captcha behind an abstraction.
// The client gets { captchaId, svg }; the expected text is stored hashed with a
// short TTL (Captcha model), single-use, attempt-limited. Required on register,
// login, and password reset.

import svgCaptcha from 'svg-captcha';
import { Captcha } from '../models/Captcha.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { sha256 } from '../utils/tokens.js';

const normalize = (text) => String(text ?? '').trim().toLowerCase();

export async function createChallenge(purpose) {
  const { text, data } = svgCaptcha.create({
    size: 5,
    noise: 2,
    ignoreChars: '0o1ilI', // ambiguous glyphs
    color: true,
  });
  const captcha = await Captcha.create({
    answerHash: sha256(normalize(text)),
    purpose,
    expiresAt: new Date(Date.now() + env.CAPTCHA_TTL_SECONDS * 1000),
  });
  return { captchaId: captcha.id, svg: data };
}

const invalid = () => ApiError.badRequest('Captcha verification failed', 'CAPTCHA_INVALID');

/**
 * Validate an answer WITHOUT consuming the challenge. Throws on any failure and
 * counts wrong answers toward the attempt cap. Used by multi-step flows (login,
 * which may bounce through a TOTP step) so the challenge stays valid until the
 * flow fully succeeds — call `consume` then.
 */
export async function verify(captchaId, answer, purpose) {
  const captcha = await Captcha.findById(captchaId).catch(() => null);
  if (!captcha || captcha.purpose !== purpose || captcha.used) throw invalid();
  if (captcha.expiresAt <= new Date()) throw invalid();
  if (captcha.attempts >= env.CAPTCHA_MAX_ATTEMPTS) throw invalid();

  if (captcha.answerHash !== sha256(normalize(answer))) {
    await Captcha.updateOne({ _id: captcha._id }, { $inc: { attempts: 1 } });
    throw invalid();
  }
  return captcha._id;
}

/** Spend a challenge so it can never be reused (atomic; safe against races). */
export async function consume(captchaId) {
  const consumed = await Captcha.findOneAndUpdate(
    { _id: captchaId, used: false },
    { $set: { used: true } },
  );
  if (!consumed) throw invalid();
}

/**
 * Validate and consume in one shot — for single-step flows (register, password
 * reset) where there is nothing between check and success.
 */
export async function verifyAndConsume(captchaId, answer, purpose) {
  await verify(captchaId, answer, purpose);
  await consume(captchaId);
}
