import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/signal.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireActive } from '../middleware/auth.js';
import { transactionLimiter } from '../middleware/rateLimit.js';
import { SIGNAL_DIRECTIONS, SIGNAL_POSITION_STATUS } from '../config/constants.js';

const router = Router();

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);

router.use(requireAuth);

router.get('/active', ctrl.listActive);

router.get(
  '/positions',
  validate({
    query: z.object({
      status: z.enum(SIGNAL_POSITION_STATUS).optional(),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  ctrl.myPositions,
);

// Place a contract order: stake in display dollars, user's own call/put choice
router.post(
  '/:id/orders',
  requireActive,
  transactionLimiter,
  validate({
    params: z.object({ id: objectId }),
    body: z.object({
      stake: z.string().regex(/^\d+(\.\d+)?$/, 'display dollars, e.g. "10"'),
      direction: z.enum(SIGNAL_DIRECTIONS),
    }),
  }),
  ctrl.placeOrder,
);

export default router;
