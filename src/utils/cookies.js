import { env, isProd } from '../config/env.js';

// Single source of truth for cookie attributes. In production the frontend and
// API will sit on different subdomains, so cookies use SameSite=None (requires
// Secure) and, once COOKIE_DOMAIN is configured, the shared parent domain.
// Dev stays lax + host-only on localhost.
export function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    domain: isProd ? env.COOKIE_DOMAIN : undefined, // undefined until the real domain is set
    path: '/',
  };
}

/** Access-token cookie (short-lived). */
export function accessCookieOptions(maxAgeMs) {
  return { ...baseCookieOptions(), maxAge: maxAgeMs };
}

/** Refresh-token cookie (long-lived). */
export function refreshCookieOptions() {
  return { ...baseCookieOptions(), maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000 };
}

/** CSRF cookie — same attributes but JS-readable, since the frontend must echo it in the header. */
export function csrfCookieOptions() {
  return { ...baseCookieOptions(), httpOnly: false };
}
