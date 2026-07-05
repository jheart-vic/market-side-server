import { Router } from 'express';
import authRoutes from './auth.routes.js';
import walletRoutes from './wallet.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/wallets', walletRoutes);
// Coming as their domains are implemented:
// router.use('/deposits', ...) /withdrawals /trades /signals /market /referrals /notifications /announcements /admin

export default router;
