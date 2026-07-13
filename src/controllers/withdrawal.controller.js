import * as withdrawalService from '../services/withdrawal.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { clientIp } from '../utils/requestIp.js';

// clientIp (not req.ip): the gateway's payout submit-IP must be the real client
// public IP, or it rejects with 该ip禁止访问 (see utils/requestIp).
const meta = (req) => ({ ip: clientIp(req), userAgent: req.get('user-agent') });

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
