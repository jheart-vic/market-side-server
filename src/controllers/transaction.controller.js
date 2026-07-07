import * as ledgerService from '../services/ledger.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/** GET /api/transactions — the caller's ledger history (statement view). */
export const getMyTransactions = asyncHandler(async (req, res) => {
  const result = await ledgerService.getHistory(req.user._id, req.validated.query);
  res.json({ success: true, ...result });
});
