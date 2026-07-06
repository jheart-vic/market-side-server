import * as referralService from '../services/referral.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const getStats = asyncHandler(async (req, res) => {
  res.json({ success: true, stats: await referralService.getStats(req.user._id) });
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
