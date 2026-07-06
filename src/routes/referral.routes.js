import { Router } from 'express';
import * as ctrl from '../controllers/referral.controller.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);

router.get('/stats', ctrl.getStats);
router.get('/link', ctrl.getLink);
router.get('/qr', ctrl.getQr);

export default router;
