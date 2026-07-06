import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/withdrawal.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireActive } from '../middleware/auth.js';
import { transactionLimiter } from '../middleware/rateLimit.js';
import { WITHDRAWAL_STATUS } from '../config/constants.js';
import { NG_BANK_CODES } from '../config/ngBanks.js';

const router = Router();

router.use(requireAuth);

router.get('/banks', ctrl.banks);

router.post(
  '/',
  requireActive,
  transactionLimiter,
  validate({
    body: z.object({
      amountUsd: z.string().regex(/^\d+(\.\d+)?$/, 'display dollars, e.g. "25"'),
      pin: z.string().regex(/^\d{4,6}$/),
      totp: z.string().regex(/^\d{6}$/).optional(), // required when 2FA is enabled
      bankCode: z.enum(NG_BANK_CODES),
      accountNumber: z.string().regex(/^\d{10,11}$/, 'NUBAN account number'),
      accountName: z.string().trim().min(3).max(100),
    }),
  }),
  ctrl.create,
);

router.get(
  '/',
  validate({
    query: z.object({
      status: z.enum(WITHDRAWAL_STATUS).optional(),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  ctrl.history,
);

export default router;
