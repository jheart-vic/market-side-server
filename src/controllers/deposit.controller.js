import * as depositService from '../services/deposit.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { clientIp } from '../utils/requestIp.js';

// clientIp (not req.ip): send the real client public IP to the gateway.
const meta = (req) => ({ ip: clientIp(req), userAgent: req.get('user-agent') });

export const create = asyncHandler(async (req, res) => {
  const deposit = await depositService.createIntent(req.user, req.validated.body, meta(req));
  res.status(201).json({ success: true, deposit });
});

export const history = asyncHandler(async (req, res) => {
  const result = await depositService.getHistory(req.user._id, req.validated.query);
  res.json({ success: true, ...result });
});
