import { Router } from 'express';
import * as ctrl from '../controllers/settings.controller.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// display-safe platform settings for deposit/withdrawal screens (auth'd users)
router.get('/', requireAuth, ctrl.getPublicSettings);

export default router;
