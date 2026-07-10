import * as authService from '../services/auth.service.js';
import * as captchaService from '../services/captcha.service.js';
import * as tokenService from '../services/token.service.js';
import * as multiAccountService from '../services/multiAccount.service.js';
import { issueCsrfCookie } from '../middleware/csrf.js';
import { COOKIES } from '../config/constants.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

// The current CSRF token to hand back in the JSON body. Cross-domain frontends
// can't read the httpOnly-adjacent ms_csrf cookie via document.cookie, so they
// rely on this to echo the token in the x-csrf-token header.
const csrfFor = (req, res) => res.locals.csrfToken || req.cookies?.[COOKIES.csrf] || issueCsrfCookie(res);

export const getCaptcha = asyncHandler(async (req, res) => {
  const { purpose } = req.validated.query;
  const challenge = await captchaService.createChallenge(purpose);
  res.json({ success: true, ...challenge });
});

export const register = asyncHandler(async (req, res) => {
  const { user, recoveryCodes, accessToken, refreshToken } = await authService.register({
    ...req.body,
    meta: meta(req),
  });
  tokenService.setAuthCookies(res, { accessToken, refreshToken });
  // recoveryCodes are shown exactly once — the frontend must prompt the user to save them
  res.status(201).json({ success: true, user, recoveryCodes, csrfToken: res.locals.csrfToken });
});

export const login = asyncHandler(async (req, res) => {
  const result = await authService.login({ ...req.body, meta: meta(req) });
  if (result.requiresTotp) {
    // password + captcha passed; frontend now shows the authenticator-code step
    return res.json({ success: true, requiresTotp: true });
  }
  tokenService.setAuthCookies(res, result);
  res.json({ success: true, user: result.user, csrfToken: res.locals.csrfToken });
});

export const adminLogin = asyncHandler(async (req, res) => {
  const result = await authService.adminLogin({ ...req.validated.body, meta: meta(req) });
  tokenService.setAuthCookies(res, result);
  res.json({ success: true, user: result.user, csrfToken: res.locals.csrfToken });
});

export const refresh = asyncHandler(async (req, res) => {
  const result = await authService.refresh(req.cookies?.[COOKIES.refresh], meta(req));
  tokenService.setAuthCookies(res, result);
  res.json({ success: true, user: result.user, csrfToken: res.locals.csrfToken });
});

// Default logout signs out only the ACTIVE account; if other accounts are
// linked in this browser, the next one is promoted (multi-account switcher).
// Single-account sessions fall through to a full logout (204), preserving the
// original contract.
export const logout = asyncHandler(async (req, res) => {
  const result = await multiAccountService.logoutActive(req, res);
  if (result.switched) {
    return res.json({
      success: true,
      switched: true,
      user: authService.toSafeUser(result.user),
      accounts: result.accounts,
      csrfToken: res.locals.csrfToken,
    });
  }
  res.status(204).end();
});

// --- multi-account switcher (Gmail-style) ----------------------------------

export const listAccounts = asyncHandler(async (req, res) => {
  res.json({ success: true, accounts: await multiAccountService.list(req, res) });
});

// Add another account to the switcher: a full login (captcha + password, and
// TOTP if 2FA is on) whose session is folded in and made active.
export const addAccount = asyncHandler(async (req, res) => {
  const result = await authService.login({ ...req.body, meta: meta(req) });
  if (result.requiresTotp) return res.json({ success: true, requiresTotp: true });
  const accounts = await multiAccountService.add(req, res, result);
  res.status(201).json({ success: true, user: result.user, accounts, csrfToken: res.locals.csrfToken });
});

// Create a brand-new account while signed in and fold it into the switcher
// (Gmail "create account"). The new account becomes active; recovery codes are
// returned once, exactly like normal registration.
export const registerAccount = asyncHandler(async (req, res) => {
  const result = await authService.register({ ...req.body, meta: meta(req) });
  const accounts = await multiAccountService.add(req, res, result);
  res.status(201).json({ success: true, user: result.user, recoveryCodes: result.recoveryCodes, accounts, csrfToken: res.locals.csrfToken });
});

export const switchAccount = asyncHandler(async (req, res) => {
  const { user, accounts } = await multiAccountService.switchTo(req, res, req.validated.body.userId);
  res.json({ success: true, user: authService.toSafeUser(user), accounts, csrfToken: res.locals.csrfToken });
});

export const removeAccount = asyncHandler(async (req, res) => {
  const result = await multiAccountService.remove(req, res, req.validated.body.userId);
  if (result.loggedOut) return res.status(204).end();
  if (result.switched) {
    return res.json({
      success: true,
      switched: true,
      user: authService.toSafeUser(result.user),
      accounts: result.accounts,
      csrfToken: res.locals.csrfToken,
    });
  }
  res.json({ success: true, accounts: result.accounts });
});

export const logoutOtherAccounts = asyncHandler(async (req, res) => {
  const { accounts } = await multiAccountService.logoutOthers(req, res);
  res.json({ success: true, accounts });
});

export const me = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    user: authService.toSafeUser(req.user),
    // non-null while an admin is browsing as this user — frontend shows a banner
    impersonation: req.impersonatedBy ? { adminId: req.impersonatedBy } : null,
    // lets a cross-domain frontend obtain the CSRF token on load (it can't read
    // the ms_csrf cookie via document.cookie across domains)
    csrfToken: csrfFor(req, res),
  });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const result = await authService.resetPassword(req.validated.body);
  res.json({ success: true, message: 'Password reset — log in with your new password', ...result });
});

export const changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword(req.user, req.body);
  tokenService.clearAuthCookies(res); // all sessions revoked — force re-login
  res.json({ success: true, message: 'Password changed — log in again' });
});

export const regenerateRecoveryCodes = asyncHandler(async (req, res) => {
  const { recoveryCodes } = await authService.regenerateRecoveryCodes(req.user, req.validated.body);
  // shown once — replaces any previous set
  res.json({ success: true, recoveryCodes });
});

export const enable2fa = asyncHandler(async (req, res) => {
  const setup = await authService.enable2fa(req.user);
  res.json({ success: true, ...setup });
});

export const confirm2fa = asyncHandler(async (req, res) => {
  await authService.confirm2fa(req.user, req.body.totp);
  res.json({ success: true, message: '2FA enabled' });
});

export const disable2fa = asyncHandler(async (req, res) => {
  await authService.disable2fa(req.user, req.body.totp);
  res.json({ success: true, message: '2FA disabled' });
});

export const setWithdrawalPin = asyncHandler(async (req, res) => {
  await authService.setWithdrawalPin(req.user, req.body);
  res.json({ success: true, message: 'Withdrawal PIN set' });
});
