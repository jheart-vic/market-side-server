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

/**
 * Validate an answer and consume the challenge. Throws on any failure; a
 * correct answer flips `used` atomically so a challenge can never be spent twice.
 */
export async function verifyAndConsume(captchaId, answer, purpose) {
  const invalid = () => ApiError.badRequest('Captcha verification failed', 'CAPTCHA_INVALID');

  const captcha = await Captcha.findById(captchaId).catch(() => null);
  if (!captcha || captcha.purpose !== purpose || captcha.used) throw invalid();
  if (captcha.expiresAt <= new Date()) throw invalid();
  if (captcha.attempts >= env.CAPTCHA_MAX_ATTEMPTS) throw invalid();

  if (captcha.answerHash !== sha256(normalize(answer))) {
    await Captcha.updateOne({ _id: captcha._id }, { $inc: { attempts: 1 } });
    throw invalid();
  }

  const consumed = await Captcha.findOneAndUpdate(
    { _id: captcha._id, used: false },
    { $set: { used: true } },
  );
  if (!consumed) throw invalid(); // raced with a parallel verify
}
