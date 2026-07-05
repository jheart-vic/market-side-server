import mongoose from 'mongoose';
import { CAPTCHA_PURPOSES } from '../config/constants.js';

const { Schema } = mongoose;

// One svg-captcha challenge. The client gets the SVG + this document's id; the
// expected text is stored hashed. Single-use, attempt-limited, and auto-expired
// by the TTL index on expiresAt.
const captchaSchema = new Schema(
  {
    answerHash: { type: String, required: true },
    purpose: { type: String, enum: CAPTCHA_PURPOSES, required: true },
    attempts: { type: Number, default: 0 },
    used: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

captchaSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Captcha = mongoose.model('Captcha', captchaSchema);
