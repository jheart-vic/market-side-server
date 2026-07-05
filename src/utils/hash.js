import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

// bcryptjs wrappers used for passwords, security-question answers, and the withdrawal PIN.

export function hashValue(value) {
  return bcrypt.hash(String(value), env.BCRYPT_ROUNDS);
}

export function compareValue(value, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(String(value), hash);
}

/** Security answers are normalized before hashing/comparison so casing and spacing don't lock users out. */
export function normalizeSecurityAnswer(answer) {
  return String(answer ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}
