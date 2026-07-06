import * as depositService from '../services/deposit.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

export const create = asyncHandler(async (req, res) => {
  const deposit = await depositService.createIntent(req.user, req.validated.body, meta(req));
  res.status(201).json({ success: true, deposit });
});

export const history = asyncHandler(async (req, res) => {
  const result = await depositService.getHistory(req.user._id, req.validated.query);
  res.json({ success: true, ...result });
});
