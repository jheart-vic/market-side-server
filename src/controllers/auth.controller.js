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
  const { user, accessToken, refreshToken } = await authService.register({
    ...req.body,
    meta: meta(req),
  });
  tokenService.setAuthCookies(res, { accessToken, refreshToken });
  res.status(201).json({ success: true, user });
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
  res.json({ success: true, user: authService.toSafeUser(req.user) });
});

export const getSecurityQuestion = asyncHandler(async (req, res) => {
  const { identifier } = req.validated.query;
  const result = await authService.getSecurityQuestion(identifier);
  res.json({ success: true, ...result });
});

export const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body);
  res.json({ success: true, message: 'Password reset — log in with your new password' });
});

export const changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword(req.user, req.body);
  tokenService.clearAuthCookies(res); // all sessions revoked — force re-login
  res.json({ success: true, message: 'Password changed — log in again' });
});

export const changeSecurityQuestion = asyncHandler(async (req, res) => {
  await authService.changeSecurityQuestion(req.user, req.body);
  res.json({ success: true, message: 'Security question updated' });
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
