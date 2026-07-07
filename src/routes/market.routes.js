import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/market.controller.js';
import { validate } from '../middleware/validate.js';
import { MARKET_ASSETS } from '../config/constants.js';

const router = Router();

// Public market data (server-side cached; dollar-first quotes per asset,
// with priceNgn included — USDT's priceNgn is the deposit/withdrawal rate)
const assetParams = z.object({ asset: z.enum(MARKET_ASSETS) });

router.get('/prices', ctrl.getPrices);
router.get('/prices/:asset', validate({ params: assetParams }), ctrl.getPrice);
router.get(
  '/ohlc/:asset',
  validate({
    params: assetParams,
    query: z.object({ days: z.coerce.number().int().positive().optional() }),
  }),
  ctrl.getOhlc,
);
router.get('/depth/:asset', validate({ params: assetParams }), ctrl.getDepth);

export default router;
