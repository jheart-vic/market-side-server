import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/transaction.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { LEDGER_TYPES, WALLET_CURRENCIES } from '../config/constants.js';

const router = Router();

export const historyQuery = z.object({
  type: z.enum(LEDGER_TYPES).optional(),
  currency: z.enum(WALLET_CURRENCIES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

router.get('/', requireAuth, validate({ query: historyQuery }), ctrl.getMyTransactions);

export default router;
