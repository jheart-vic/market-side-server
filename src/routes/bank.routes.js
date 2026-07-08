import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/bankAccount.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { NG_BANK_CODES } from '../config/ngBanks.js';

const router = Router();

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);
const idParams = z.object({ id: objectId });

router.use(requireAuth);

router.get('/list', ctrl.listBanks);
router.get('/accounts', ctrl.getAccounts);

router.post(
  '/bind',
  validate({
    body: z.object({
      bankCode: z.enum(NG_BANK_CODES),
      accountName: z.string().trim().min(3).max(100),
      accountNumber: z.string().regex(/^\d{10,11}$/, 'NUBAN account number'),
    }),
  }),
  ctrl.bind,
);

router.post('/accounts/:id/default', validate({ params: idParams }), ctrl.setDefault);
router.delete('/accounts/:id', validate({ params: idParams }), ctrl.remove);

export default router;
