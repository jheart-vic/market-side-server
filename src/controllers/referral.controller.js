import * as referralService from '../services/referral.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const getStats = asyncHandler(async (req, res) => {
  res.json({ success: true, stats: await referralService.getStats(req.user._id) });
});

export const getMembers = asyncHandler(async (req, res) => {
  const result = await referralService.getMembers(req.user._id, req.validated.query);
  res.json({ success: true, ...result });
});

export const getLink = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    link: referralService.getShareLink(req.user),
    referralCode: req.user.referralCode,
  });
});

export const getQr = asyncHandler(async (req, res) => {
  res.json({ success: true, ...(await referralService.getQrCode(req.user)) });
});
