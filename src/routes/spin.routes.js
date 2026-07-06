import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/spin.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireActive } from '../middleware/auth.js';
import { transactionLimiter } from '../middleware/rateLimit.js';

const router = Router();

router.use(requireAuth);

router.get('/', ctrl.getWheel);
// Spinning pays money into the wallet → frozen users can't, and it rate-limits
// like the other transacting routes
router.post('/', requireActive, transactionLimiter, ctrl.spin);
router.get(
  '/history',
  validate({
    query: z.object({
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  ctrl.history,
);

export default router;
