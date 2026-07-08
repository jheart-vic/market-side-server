import { randomInt } from 'node:crypto';
import { sha256 } from './tokens.js';

// One-time recovery codes for password reset (replaces security questions).
// Codes are high-entropy random, so a fast hash (sha256) is the right store —
// bcrypt's slowness only matters for low-entropy secrets like passwords/PINs,
// and hashing a whole set with bcrypt at registration would be needlessly slow.

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // unambiguous: no 0/O/1/I/L
const CODE_LEN = 10;
export const RECOVERY_CODE_COUNT = 10;

/** Strip spaces/dashes and uppercase so display formatting never affects matching. */
export function normalizeRecoveryCode(code) {
  return String(code ?? '').replace(/[\s-]/g, '').toUpperCase();
}

export function hashRecoveryCode(code) {
  return sha256(normalizeRecoveryCode(code));
}

/** One display code, grouped for readability, e.g. "A3F9K-2M7QX". */
export function generateRecoveryCode() {
  let raw = '';
  for (let i = 0; i < CODE_LEN; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/**
 * A fresh set. Returns { plain, stored }: `plain` is shown to the user exactly
 * once; `stored` (hashed, unused) is persisted on the User document.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const plain = Array.from({ length: count }, generateRecoveryCode);
  const stored = plain.map((code) => ({ codeHash: hashRecoveryCode(code), usedAt: null }));
  return { plain, stored };
}
