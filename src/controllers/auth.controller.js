import * as authService from '../services/auth.service.js';
import * as captchaService from '../services/captcha.service.js';
import * as tokenService from '../services/token.service.js';
import { COOKIES } from '../config/constants.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

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
  res.status(201).json({ success: true, user, recoveryCodes });
});

export const login = asyncHandler(async (req, res) => {
  const result = await authService.login({ ...req.body, meta: meta(req) });
  if (result.requiresTotp) {
    // password + captcha passed; frontend now shows the authenticator-code step
    return res.json({ success: true, requiresTotp: true });
  }
  tokenService.setAuthCookies(res, result);
  res.json({ success: true, user: result.user });
});

export const adminLogin = asyncHandler(async (req, res) => {
  const result = await authService.adminLogin({ ...req.validated.body, meta: meta(req) });
  tokenService.setAuthCookies(res, result);
  res.json({ success: true, user: result.user });
});

export const refresh = asyncHandler(async (req, res) => {
  const result = await authService.refresh(req.cookies?.[COOKIES.refresh], meta(req));
  tokenService.setAuthCookies(res, result);
  res.json({ success: true, user: result.user });
});

export const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.cookies?.[COOKIES.refresh]);
  tokenService.clearAuthCookies(res);
  res.status(204).end();
});

export const me = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    user: authService.toSafeUser(req.user),
    // non-null while an admin is browsing as this user — frontend shows a banner
    impersonation: req.impersonatedBy ? { adminId: req.impersonatedBy } : null,
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
