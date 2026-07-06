import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/announcement.controller.js';
import { validate } from '../middleware/validate.js';

const router = Router();

// Public: homepage + announcements screen (admin CRUD lives under /api/admin)
router.get(
  '/',
  validate({
    query: z.object({
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  ctrl.listPublished,
);

export default router;
