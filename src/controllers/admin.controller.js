import * as userService from '../services/user.service.js';
import * as authService from '../services/auth.service.js';
import * as tokenService from '../services/token.service.js';
import * as walletService from '../services/wallet.service.js';
import * as reportService from '../services/report.service.js';
import * as spinService from '../services/spin.service.js';
import * as signalService from '../services/signal.service.js';
import * as depositService from '../services/deposit.service.js';
import * as withdrawalService from '../services/withdrawal.service.js';
import * as settingsService from '../services/settings.service.js';
import * as paymentService from '../services/payment.service.js';
import * as ledgerService from '../services/ledger.service.js';
import * as referralService from '../services/referral.service.js';
import * as announcementService from '../services/announcement.service.js';
import * as notificationService from '../services/notification.service.js';
import * as auditService from '../services/audit.service.js';
import { toSmallestUnits, fromSmallestUnits } from '../utils/money.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

// --- users ---

export const searchUsers = asyncHandler(async (req, res) => {
  const result = await userService.searchUsers(req.validated.query);
  res.json({ success: true, ...result });
});

export const getUser = asyncHandler(async (req, res) => {
  res.json({ success: true, profile: await userService.getProfile(req.validated.params.id) });
});

export const setUserStatus = asyncHandler(async (req, res) => {
  const { status, reason } = req.validated.body;
  const result = await userService.setAccountStatus(req.user, req.validated.params.id, status, reason);
  res.json({ success: true, ...result });
});

export const reviewKyc = asyncHandler(async (req, res) => {
  const { decision, reason } = req.validated.body;
  const result = await userService.reviewKyc(req.user, req.validated.params.id, decision, reason);
  res.json({ success: true, ...result });
});

export const getUserTransactions = asyncHandler(async (req, res) => {
  const result = await ledgerService.getHistory(req.validated.params.id, req.validated.query);
  res.json({ success: true, ...result });
});

// --- impersonation (support tool: browse AS the user; admin routes stay blocked) ---

export const impersonateUser = asyncHandler(async (req, res) => {
  const { accessToken, user } = await authService.impersonate(req.user, req.validated.params.id, {
    reason: req.validated.body?.reason,
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  // Access cookie only — the admin's refresh session survives for the exit
  tokenService.setAccessCookie(res, accessToken, tokenService.IMPERSONATION_TTL_MS);
  res.json({ success: true, impersonating: true, expiresInMs: tokenService.IMPERSONATION_TTL_MS, user });
});

export const exitImpersonation = asyncHandler(async (req, res) => {
  if (!req.impersonatedBy) {
    throw ApiError.badRequest('Not currently impersonating', 'NOT_IMPERSONATING');
  }
  const { accessToken, user } = await authService.exitImpersonation(req.impersonatedBy, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  tokenService.setAccessCookie(res, accessToken);
  res.json({ success: true, impersonating: false, user });
});

// --- wallet adjustments (always audited ledger entries with a reason) ---

export const adjustWallet = asyncHandler(async (req, res) => {
  const { id: userId } = req.validated.params;
  const { currency, direction, amount, reason } = req.validated.body;
  const units = toSmallestUnits(amount, currency);

  const operation = direction === 'credit' ? ledgerService.credit : ledgerService.debit;
  const { groupId } = await operation({
    user: userId,
    currency,
    amount: units,
    type: 'admin_adjustment',
    narration: reason,
    performedBy: req.user._id,
  });

  await auditService.record({
    actor: req.user,
    action: `wallet.${direction}`,
    target: { kind: 'User', item: userId },
    meta: { currency, amount, reason, groupId: String(groupId) },
  });
  await notificationService.notifyUser(userId, {
    type: 'admin_adjustment',
    title: `Wallet ${direction === 'credit' ? 'credited' : 'debited'}`,
    body: `Your ${currency} wallet was ${direction}ed with ${fromSmallestUnits(units, currency)} ${currency}. Reason: ${reason}`,
    meta: { currency, amount, direction },
  });

  const wallet = await walletService.getWallet(userId, currency);
  const after = toSmallestUnits(wallet.balance, currency);
  const before = direction === 'credit' ? after - units : after + units;
  res.status(201).json({
    success: true,
    groupId,
    currency,
    direction,
    amount: fromSmallestUnits(units, currency),
    balanceBefore: fromSmallestUnits(before, currency),
    balanceAfter: wallet.balance,
  });
});

// --- spins (grant credits + activity feed; prizes live in platform settings) ---

export const grantSpins = asyncHandler(async (req, res) => {
  const { count, reason } = req.validated.body;
  const result = await spinService.grantCredits(req.user, req.validated.params.id, count, reason);
  res.status(201).json({ success: true, ...result });
});

export const listSpins = asyncHandler(async (req, res) => {
  const result = await spinService.adminList(req.validated.query);
  res.json({ success: true, ...result });
});

export const reconcile = asyncHandler(async (req, res) => {
  const { userId, fix } = req.validated.body;
  const result = await ledgerService.reconcile(userId, { fix: fix === true });
  res.json({ success: true, ...result });
});

// --- audit + notifications ---

export const auditFeed = asyncHandler(async (req, res) => {
  const result = await auditService.feed(req.validated.query);
  res.json({ success: true, ...result });
});

export const notifications = asyncHandler(async (req, res) => {
  const { unreadOnly, ...query } = req.validated.query;
  const result = await notificationService.adminList({ unreadOnly: unreadOnly === 'true', ...query });
  res.json({ success: true, ...result });
});

// --- reports (dashboard cards + daily chart series) ---

export const reportOverview = asyncHandler(async (req, res) => {
  res.json({ success: true, report: await reportService.overview(req.validated.query) });
});

export const reportTimeseries = asyncHandler(async (req, res) => {
  const result = await reportService.timeseries(req.validated.query);
  res.json({ success: true, ...result });
});

// --- referral rates ---

export const getReferralRates = asyncHandler(async (req, res) => {
  res.json({ success: true, rates: await referralService.getRates() });
});

export const setReferralRates = asyncHandler(async (req, res) => {
  const rates = await referralService.setRates(req.user, req.validated.body.rates);
  res.json({ success: true, rates });
});

// --- deposits / withdrawals ---

export const listDeposits = asyncHandler(async (req, res) => {
  const result = await depositService.adminList(req.validated.query);
  res.json({ success: true, ...result });
});

export const approveDeposit = asyncHandler(async (req, res) => {
  const deposit = await depositService.manualApprove(req.user, req.validated.params.id);
  res.json({ success: true, deposit });
});

export const rejectDeposit = asyncHandler(async (req, res) => {
  const deposit = await depositService.manualReject(req.user, req.validated.params.id, req.validated.body.reason);
  res.json({ success: true, deposit });
});

export const listWithdrawals = asyncHandler(async (req, res) => {
  const result = await withdrawalService.adminList(req.validated.query);
  res.json({ success: true, ...result });
});

export const approveWithdrawal = asyncHandler(async (req, res) => {
  const withdrawal = await withdrawalService.approve(req.user, req.validated.params.id);
  res.json({ success: true, withdrawal });
});

export const rejectWithdrawal = asyncHandler(async (req, res) => {
  const withdrawal = await withdrawalService.reject(req.user, req.validated.params.id, req.validated.body.reason);
  res.json({ success: true, withdrawal });
});

/** Merchant float at the gateway (shared across projects on this account). */
export const gatewayBalance = asyncHandler(async (req, res) => {
  res.json({ success: true, balance: await paymentService.getBalance() });
});

// --- platform settings ---

export const getPlatformSettings = asyncHandler(async (req, res) => {
  res.json({ success: true, settings: await settingsService.getSettings() });
});

export const updatePlatformSettings = asyncHandler(async (req, res) => {
  const settings = await settingsService.setSettings(req.user, req.validated.body);
  res.json({ success: true, settings });
});

// --- trading signals ---

export const createSignal = asyncHandler(async (req, res) => {
  const signal = await signalService.createSignal(req.user, req.validated.body);
  res.status(201).json({ success: true, signal });
});

export const listSignals = asyncHandler(async (req, res) => {
  const { day, ...query } = req.validated.query;
  const result = await signalService.listForDay(day, query);
  res.json({ success: true, ...result });
});

export const updateSignal = asyncHandler(async (req, res) => {
  const signal = await signalService.updateSignal(req.user, req.validated.params.id, req.validated.body);
  res.json({ success: true, signal });
});

export const cancelSignal = asyncHandler(async (req, res) => {
  const result = await signalService.cancelSignal(req.user, req.validated.params.id, req.validated.body.reason);
  res.json({ success: true, ...result });
});

export const deleteSignal = asyncHandler(async (req, res) => {
  const result = await signalService.deleteSignal(req.user, req.validated.params.id);
  res.json({ success: true, ...result });
});

export const releaseSignals = asyncHandler(async (req, res) => {
  // manual trigger; force bypasses the 3–5 pm Lagos release window
  const result = await signalService.releaseDueSignals({ force: req.validated.body.force === true });
  await auditService.record({ actor: req.user, action: 'signal.release', meta: result });
  res.json({ success: true, ...result });
});

// --- announcements ---

export const createAnnouncement = asyncHandler(async (req, res) => {
  const announcement = await announcementService.create(req.user, req.validated.body);
  res.status(201).json({ success: true, announcement });
});

export const listAnnouncements = asyncHandler(async (req, res) => {
  const result = await announcementService.adminList(req.validated.query);
  res.json({ success: true, ...result });
});

export const updateAnnouncement = asyncHandler(async (req, res) => {
  const announcement = await announcementService.update(req.user, req.validated.params.id, req.validated.body);
  res.json({ success: true, announcement });
});

export const removeAnnouncement = asyncHandler(async (req, res) => {
  await announcementService.remove(req.user, req.validated.params.id);
  res.status(204).end();
});
