import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/salary.controller.js';
import { requireAuth, requireActive } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { SALARY_TIERS } from '../config/constants.js';

const router = Router();

router.use(requireAuth);

const MAX_TIER = SALARY_TIERS[SALARY_TIERS.length - 1].tier;
const tierParam = z.object({ tier: z.coerce.number().int().min(0).max(MAX_TIER) });
const claimBody = z.object({
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(6).max(20),
});

router.get('/', ctrl.getStatus);
router.get('/claims', ctrl.getClaims);
// requireActive: frozen users can't claim rewards
router.post(
  '/:tier/claim',
  requireActive,
  validate({ params: tierParam, body: claimBody }),
  ctrl.claim,
);

export default router;
