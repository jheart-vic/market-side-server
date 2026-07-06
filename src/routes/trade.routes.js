import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/trade.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireActive } from '../middleware/auth.js';
import { transactionLimiter } from '../middleware/rateLimit.js';
import { TRADE_ASSETS, TRADE_SIDES } from '../config/constants.js';

const router = Router();

router.use(requireAuth);

// buys: amount = dollars to spend; sells: amount = base asset to sell
router.post(
  '/',
  requireActive,
  transactionLimiter,
  validate({
    body: z.object({
      asset: z.enum(TRADE_ASSETS),
      side: z.enum(TRADE_SIDES),
      amount: z.string().regex(/^\d+(\.\d+)?$/, 'display units, e.g. "50" or "0.0005"'),
    }),
  }),
  ctrl.execute,
);

router.get(
  '/',
  validate({
    query: z.object({
      asset: z.enum(TRADE_ASSETS).optional(),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  ctrl.history,
);

router.get('/pnl', ctrl.pnl);

export default router;
