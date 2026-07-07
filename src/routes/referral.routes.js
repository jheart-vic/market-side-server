import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/referral.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { REFERRAL_LEVELS } from '../config/constants.js';

const router = Router();

router.use(requireAuth);

const membersQuery = z.object({
  level: z.coerce.number().int().min(1).max(REFERRAL_LEVELS),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

router.get('/stats', ctrl.getStats);
router.get('/members', validate({ query: membersQuery }), ctrl.getMembers);
router.get('/link', ctrl.getLink);
router.get('/qr', ctrl.getQr);

export default router;
