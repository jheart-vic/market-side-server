import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/wallet.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { WALLET_CURRENCIES } from '../config/constants.js';

const router = Router();

router.use(requireAuth);

router.get('/', ctrl.getWallets);
router.get(
  '/:currency',
  validate({ params: z.object({ currency: z.enum(WALLET_CURRENCIES) }) }),
  ctrl.getWallet,
);

export default router;
