import { Router } from 'express';
import authRoutes from './auth.routes.js';
import walletRoutes from './wallet.routes.js';
import userRoutes from './user.routes.js';
import transactionRoutes from './transaction.routes.js';
import referralRoutes from './referral.routes.js';
import notificationRoutes from './notification.routes.js';
import announcementRoutes from './announcement.routes.js';
import marketRoutes from './market.routes.js';
import tradeRoutes from './trade.routes.js';
import signalRoutes from './signal.routes.js';
import spinRoutes from './spin.routes.js';
import depositRoutes from './deposit.routes.js';
import withdrawalRoutes from './withdrawal.routes.js';
import paymentRoutes from './payment.routes.js';
import settingsRoutes from './settings.routes.js';
import adminRoutes from './admin.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/wallets', walletRoutes);
router.use('/users', userRoutes);
router.use('/transactions', transactionRoutes);
router.use('/referrals', referralRoutes);
router.use('/notifications', notificationRoutes);
router.use('/announcements', announcementRoutes);
router.use('/market', marketRoutes);
router.use('/trades', tradeRoutes);
router.use('/signals', signalRoutes);
router.use('/spin', spinRoutes);
router.use('/deposits', depositRoutes);
router.use('/withdrawals', withdrawalRoutes);
router.use('/payments', paymentRoutes); // gateway webhooks (IP + signature gated)
router.use('/settings', settingsRoutes); // display-safe platform settings
router.use('/admin', adminRoutes);

export default router;
