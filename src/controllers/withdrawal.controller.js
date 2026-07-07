import * as withdrawalService from '../services/withdrawal.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

export const banks = asyncHandler(async (req, res) => {
  res.json({ success: true, banks: withdrawalService.listBanks() });
});

export const create = asyncHandler(async (req, res) => {
  const withdrawal = await withdrawalService.requestWithdrawal(req.user, req.validated.body, meta(req));
  res.status(201).json({ success: true, withdrawal });
});

export const history = asyncHandler(async (req, res) => {
  const result = await withdrawalService.getHistory(req.user._id, req.validated.query);
  res.json({ success: true, ...result });
});
