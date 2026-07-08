import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/session.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);

router.get('/', ctrl.list);
router.post('/revoke-others', ctrl.revokeOthers); // log out all other devices
router.delete('/:id', validate({ params: z.object({ id: z.string().regex(/^[0-9a-fA-F]{24}$/) }) }), ctrl.revoke);

export default router;
