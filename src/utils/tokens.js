import crypto from 'node:crypto';

/** Opaque random token (refresh tokens, deposit references, etc.). */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** SHA-256 hex digest — refresh tokens are stored hashed, like passwords. */
export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
