import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/notification.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);

export const listQuery = z.object({
  unreadOnly: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

router.use(requireAuth);

router.get('/', validate({ query: listQuery }), ctrl.list);
router.post('/read-all', ctrl.markAllRead);
router.post('/:id/read', validate({ params: z.object({ id: objectId }) }), ctrl.markRead);

export default router;
