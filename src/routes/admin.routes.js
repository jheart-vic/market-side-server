import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/admin.controller.js';
import * as salaryCtrl from '../controllers/salary.controller.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { historyQuery } from './transaction.routes.js';
import { REPORT_METRICS } from '../services/report.service.js';
import {
  ACCOUNT_STATUS,
  KYC_STATUS,
  ROLES,
  WALLET_CURRENCIES,
  SIGNAL_PAIRS,
  SIGNAL_DIRECTIONS,
  DEPOSIT_STATUS,
  WITHDRAWAL_STATUS,
  SALARY_CLAIM_STATUS,
} from '../config/constants.js';

const router = Router();

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);
const idParams = z.object({ id: objectId });
const pagination = {
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
};

// Exit impersonation is called while authenticated AS the target user — the
// token's `imp` claim (checked in the handler), not the role, authorizes it,
// so it must sit before the role gate (requireRole rejects impersonated sessions).
router.post('/impersonation/exit', requireAuth, ctrl.exitImpersonation);

router.use(requireAuth, requireRole('admin'));

// --- users ---
router.get(
  '/users',
  validate({
    query: z.object({
      q: z.string().trim().min(1).max(100).optional(),
      status: z.enum(ACCOUNT_STATUS).optional(),
      kycStatus: z.enum(KYC_STATUS).optional(),
      role: z.enum(ROLES).optional(),
      ...pagination,
    }),
  }),
  ctrl.searchUsers,
);
router.get('/users/:id', validate({ params: idParams }), ctrl.getUser);
router.post(
  '/users/:id/status',
  validate({
    params: idParams,
    body: z.object({ status: z.enum(ACCOUNT_STATUS), reason: z.string().trim().max(300).optional() }),
  }),
  ctrl.setUserStatus,
);
router.post(
  '/users/:id/kyc',
  validate({
    params: idParams,
    body: z.object({
      decision: z.enum(['approved', 'rejected']),
      reason: z.string().trim().max(300).optional(),
    }),
  }),
  ctrl.reviewKyc,
);
router.get(
  '/users/:id/transactions',
  validate({ params: idParams, query: historyQuery }),
  ctrl.getUserTransactions,
);
// Login AS a user (support): overwrites only the access cookie for 2h
router.post(
  '/users/:id/impersonate',
  validate({
    params: idParams,
    body: z.object({ reason: z.string().trim().max(300).optional() }),
  }),
  ctrl.impersonateUser,
);

// --- wallet adjustments ---
router.post(
  '/users/:id/wallet',
  validate({
    params: idParams,
    body: z.object({
      currency: z.enum(WALLET_CURRENCIES),
      direction: z.enum(['credit', 'debit']),
      amount: z.string().regex(/^\d+(\.\d+)?$/, 'display units, e.g. "1500.50"'),
      reason: z.string().trim().min(3).max(300),
    }),
  }),
  ctrl.adjustWallet,
);

// --- spins (wheel prizes are configured via PUT /settings) ---
router.post(
  '/users/:id/spins',
  validate({
    params: idParams,
    body: z.object({
      count: z.number().int().min(1).max(100),
      reason: z.string().trim().min(3).max(300),
    }),
  }),
  ctrl.grantSpins,
);
router.get(
  '/spins',
  validate({
    query: z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      user: objectId.optional(),
      ...pagination,
    }),
  }),
  ctrl.listSpins,
);

// balance repair is superadmin-only (fix:true rewrites wallet columns)
router.post(
  '/reconcile',
  requireRole('superadmin'),
  validate({ body: z.object({ userId: objectId.optional(), fix: z.boolean().optional() }) }),
  ctrl.reconcile,
);

// --- audit + notifications ---
router.get(
  '/audit',
  validate({
    query: z.object({
      actor: objectId.optional(),
      action: z.string().trim().max(60).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      ...pagination,
    }),
  }),
  ctrl.auditFeed,
);
router.get(
  '/notifications',
  validate({ query: z.object({ unreadOnly: z.enum(['true', 'false']).optional(), ...pagination }) }),
  ctrl.notifications,
);

// --- reports ---
const dateRange = { from: z.coerce.date().optional(), to: z.coerce.date().optional() };
router.get('/reports/overview', validate({ query: z.object(dateRange) }), ctrl.reportOverview);
router.get(
  '/reports/timeseries',
  validate({ query: z.object({ metric: z.enum(REPORT_METRICS), ...dateRange }) }),
  ctrl.reportTimeseries,
);

// --- referral rates ---
router.get('/referral-rates', ctrl.getReferralRates);
router.put(
  '/referral-rates',
  validate({ body: z.object({ rates: z.record(z.string(), z.number()) }) }),
  ctrl.setReferralRates,
);

// --- deposits / withdrawals / gateway ---
const reasonBody = z.object({ reason: z.string().trim().max(300).optional() });

router.get(
  '/deposits',
  validate({ query: z.object({ status: z.enum(DEPOSIT_STATUS).optional(), ...pagination }) }),
  ctrl.listDeposits,
);
router.post('/deposits/:id/approve', validate({ params: idParams }), ctrl.approveDeposit);
router.post('/deposits/:id/reject', validate({ params: idParams, body: reasonBody }), ctrl.rejectDeposit);

router.get(
  '/withdrawals',
  validate({ query: z.object({ status: z.enum(WITHDRAWAL_STATUS).optional(), ...pagination }) }),
  ctrl.listWithdrawals,
);
router.post('/withdrawals/:id/approve', validate({ params: idParams }), ctrl.approveWithdrawal);
router.post('/withdrawals/:id/reject', validate({ params: idParams, body: reasonBody }), ctrl.rejectWithdrawal);

router.get('/payments/balance', ctrl.gatewayBalance);

// --- platform settings (mins, fees, withdrawal window, FX mode/spreads) ---
router.get('/settings', ctrl.getPlatformSettings);
router.put(
  '/settings',
  validate({
    body: z.object({
      min_deposit_usd: z.number().positive().optional(),
      min_withdrawal_usd: z.number().positive().optional(),
      withdrawal_fee_pct_below: z.number().min(0).max(50).optional(),
      withdrawal_fee_pct_above: z.number().min(0).max(50).optional(),
      withdrawal_fee_threshold_usd: z.number().positive().optional(),
      withdrawal_days: z.string().trim().min(3).max(100).optional(),
      withdrawal_hours: z.string().trim().min(3).max(100).optional(),
      withdrawal_daily_limit: z.number().int().min(1).max(20).optional(),
      fx_mode: z.enum(['live', 'fixed']).optional(),
      fx_fixed_rate_ngn: z.number().positive().optional(),
      deposit_spread_pct: z.number().min(0).max(20).optional(),
      withdrawal_spread_pct: z.number().min(0).max(20).optional(),
      // Spin & Win wheel: exactly 9 prize values in display dollars (strings —
      // money never floats); only the two lowest are ever won
      spin_prizes: z
        .array(z.string().regex(/^\d+(\.\d+)?$/, 'display dollars, e.g. "0.5"'))
        .length(9)
        .optional(),
      spin_bonus_every: z.number().int().min(2).max(1000).optional(),
      spin_referral_reward: z.number().int().min(0).max(10).optional(),
      // Trading-signals release window (Lagos HH:mm)
      signal_release_start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm').optional(),
      signal_release_end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm').optional(),
    }),
  }),
  ctrl.updatePlatformSettings,
);

// --- trading signals ---
const stakeAmount = z.string().regex(/^\d+(\.\d+)?$/, 'display dollars, e.g. "10"');
const signalBody = {
  pair: z.enum(SIGNAL_PAIRS),
  direction: z.enum(SIGNAL_DIRECTIONS), // admin's winning side — hidden from users
  // fractional returns allowed (2.5, 2.3…); capped at 2dp — percentOf() does
  // String(percent), and a value under 1e-6 would stringify as "1e-7" and throw
  returnPct: z.number().min(0).max(500).multipleOf(0.01),
  minStake: stakeAmount,
  maxStake: stakeAmount,
  durationSeconds: z.number().int().min(10).max(86400),
  releaseDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
};
router.post('/signals', validate({ body: z.object(signalBody) }), ctrl.createSignal);
router.get(
  '/signals',
  validate({
    query: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), ...pagination }),
  }),
  ctrl.listSignals,
);
router.patch(
  '/signals/:id',
  validate({
    params: idParams,
    body: z.object(Object.fromEntries(Object.entries(signalBody).map(([k, v]) => [k, v.optional()]))),
  }),
  ctrl.updateSignal,
);
router.post(
  '/signals/:id/cancel',
  validate({ params: idParams, body: z.object({ reason: z.string().trim().max(300).optional() }) }),
  ctrl.cancelSignal,
);
// Hard-delete a signal that has no contracts on it (use cancel to refund if it does)
router.delete('/signals/:id', validate({ params: idParams }), ctrl.deleteSignal);
router.post(
  '/signals/release',
  validate({ body: z.object({ force: z.boolean().optional() }) }),
  ctrl.releaseSignals,
);

// --- salary reward claims (manual fulfillment) ---
router.get(
  '/salary/claims',
  validate({
    query: z.object({
      status: z.enum(SALARY_CLAIM_STATUS).optional(),
      tier: z.coerce.number().int().min(0).optional(),
      ...pagination,
    }),
  }),
  salaryCtrl.adminList,
);
router.post(
  '/salary/claims/:id/review',
  validate({
    params: idParams,
    body: z.object({
      decision: z.enum(['fulfilled', 'rejected']),
      note: z.string().trim().max(300).optional(),
    }),
  }),
  salaryCtrl.adminReview,
);

// --- announcements ---
const announcementBody = {
  title: z.string().trim().min(3).max(150),
  body: z.string().trim().min(3).max(5000),
  published: z.boolean().optional(),
};
router.post('/announcements', validate({ body: z.object(announcementBody) }), ctrl.createAnnouncement);
router.get('/announcements', validate({ query: z.object(pagination) }), ctrl.listAnnouncements);
router.patch(
  '/announcements/:id',
  validate({
    params: idParams,
    body: z.object({
      title: announcementBody.title.optional(),
      body: announcementBody.body.optional(),
      published: z.boolean().optional(),
    }),
  }),
  ctrl.updateAnnouncement,
);
router.delete('/announcements/:id', validate({ params: idParams }), ctrl.removeAnnouncement);

export default router;
