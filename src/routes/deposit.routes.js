import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/deposit.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireActive } from '../middleware/auth.js';
import { transactionLimiter } from '../middleware/rateLimit.js';
import { DEPOSIT_STATUS } from '../config/constants.js';

const router = Router();

router.use(requireAuth);

// amountUsd: display dollars ("50") — the NGN checkout amount is computed at the locked rate
router.post(
  '/',
  requireActive,
  transactionLimiter,
  validate({
    body: z.object({
      amountUsd: z.string().regex(/^\d+(\.\d+)?$/, 'display dollars, e.g. "50"'),
    }),
  }),
  ctrl.create,
);

router.get(
  '/',
  validate({
    query: z.object({
      status: z.enum(DEPOSIT_STATUS).optional(),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  ctrl.history,
);

export default router;
