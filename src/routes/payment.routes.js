import { Router } from 'express';
import * as ctrl from '../controllers/payment.controller.js';
import { ipAllowlist } from '../middleware/ipAllowlist.js';
import { env } from '../config/env.js';

const router = Router();

// Gateway webhooks: no auth cookie (so CSRF is skipped), gated by source-IP
// allowlist + MD5 signature verification inside the controller.
const gate = ipAllowlist(env.PG_CALLBACK_IPS);

router.post('/deposit/callback', gate, ctrl.depositCallback);
router.post('/withdraw/callback', gate, ctrl.withdrawCallback);

export default router;
