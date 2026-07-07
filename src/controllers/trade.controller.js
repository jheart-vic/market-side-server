import * as tradeService from '../services/trade.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const execute = asyncHandler(async (req, res) => {
  const trade = await tradeService.executeTrade(req.user, req.validated.body);
  res.status(201).json({ success: true, trade });
});

export const history = asyncHandler(async (req, res) => {
  const result = await tradeService.getHistory(req.user._id, req.validated.query);
  res.json({ success: true, ...result });
});

export const pnl = asyncHandler(async (req, res) => {
  res.json({ success: true, pnl: await tradeService.getPnl(req.user._id) });
});
