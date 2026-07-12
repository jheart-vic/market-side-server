// WithdrawalService (SPEC §2.4) — dollar withdrawals paid out in naira.
// Request: PIN (+ TOTP when 2FA on) → admin-configured window/limit checks →
// fee → USD→NGN at the locked withdrawal rate (whole naira, Nigeria rule) →
// the GROSS dollar amount is held via ledger → payout submitted to the
// gateway. Callback settles the hold (paid) or releases it (refund). Statuses:
// pending (created) → approved (gateway accepted / processing) → paid |
// rejected. Admin can manually mark paid or reject at any pre-paid stage.

import mongoose from 'mongoose';
import { Withdrawal } from '../models/Withdrawal.js';
import { PLATFORM_CURRENCY } from '../config/constants.js';
import { NG_BANKS, NG_BANK_CODES } from '../config/ngBanks.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import { lagosParts, lagosWeekday, lagosDayKey } from '../utils/time.js';
import {
  toSmallestUnits,
  fromSmallestUnits,
  bigIntToDecimal128,
  decimal128ToBigInt,
  percentOf,
} from '../utils/money.js';
import * as paymentService from './payment.service.js';
import * as settingsService from './settings.service.js';
import * as ledgerService from './ledger.service.js';
import * as authService from './auth.service.js';
import * as notificationService from './notification.service.js';
import * as auditService from './audit.service.js';
import * as bankAccountService from './bankAccount.service.js';
import { usdNgnRateKobo, usdMicroToNgnKobo } from './fx.service.js';

// ---------------------------------------------------------------------------
// Admin-configured withdrawal window (Africa/Lagos wall clock — improvement
// over the sister project, which used raw server time)
// ---------------------------------------------------------------------------

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** "10:00 AM", "5:00PM", "10AM", "14:30" → minutes since midnight, or null. */
function parseTimeToMinutes(str) {
  if (!str || typeof str !== 'string') return null;
  const clean = str.trim().toUpperCase();

  const m12 = clean.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (m12) {
    let hours = Number(m12[1]) % 12;
    if (m12[3] === 'PM') hours += 12;
    return hours * 60 + Number(m12[2] ?? 0);
  }
  const m24 = clean.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) return Number(m24[1]) * 60 + Number(m24[2]);
  return null;
}

/** "10:00 AM – 05:00 PM" / "- " / "to" → { start, end } minutes, or null. */
function parseHoursRange(hoursStr) {
  if (!hoursStr || typeof hoursStr !== 'string') return null;
  const parts = hoursStr.split(/\s*(?:–|-|to)\s*/i);
  if (parts.length !== 2) return null;
  const start = parseTimeToMinutes(parts[0]);
  const end = parseTimeToMinutes(parts[1]);
  return start === null || end === null ? null : { start, end };
}

/**
 * True when now (Lagos) falls inside the admin-configured days + hours.
 * Unparseable settings fail OPEN so a config typo never blocks all withdrawals.
 */
export function isWithinWithdrawalWindow(daysStr, hoursStr, date = new Date()) {
  const today = lagosWeekday(date);

  let dayAllowed = true;
  if (daysStr && typeof daysStr === 'string') {
    const clean = daysStr.trim().toLowerCase();
    const range = clean.match(/^(\w+)\s+to\s+(\w+)$/);
    if (range) {
      const start = DAY_NAMES.indexOf(range[1]);
      const end = DAY_NAMES.indexOf(range[2]);
      if (start !== -1 && end !== -1) {
        dayAllowed = start <= end ? today >= start && today <= end : today >= start || today <= end;
      }
    } else {
      const indices = clean
        .split(/\s*,\s*/)
        .map((d) => DAY_NAMES.indexOf(d))
        .filter((i) => i !== -1);
      if (indices.length) dayAllowed = indices.includes(today);
    }
  }
  if (!dayAllowed) return false;

  const hours = parseHoursRange(hoursStr);
  if (!hours) return true;
  const { hour, minute } = lagosParts(date);
  const now = hour * 60 + minute;
  return now >= hours.start && now < hours.end;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function toDisplay(withdrawal) {
  const rate = withdrawal.exchangeRate ? decimal128ToBigInt(withdrawal.exchangeRate) : null;
  const usd = (v) => (v == null ? null : fromSmallestUnits(decimal128ToBigInt(v), PLATFORM_CURRENCY));
  return {
    id: withdrawal.id,
    reference: `MS${withdrawal.id}`, // our merchant order id sent to the gateway
    // Beidou platform order number for this payout (arrives on the callback)
    gatewayOrderId: withdrawal.payoutReference ?? null,
    amountUsd: usd(withdrawal.amountUsd),
    feeUsd: usd(withdrawal.fee),
    netAmountUsd: usd(withdrawal.netAmountUsd),
    payoutNgn: fromSmallestUnits(decimal128ToBigInt(withdrawal.amount), 'NGN'),
    exchangeRate: rate ? fromSmallestUnits(rate, 'NGN') : null, // NGN per $1
    bank: {
      bankCode: withdrawal.bank.bankCode,
      bankName: withdrawal.bank.bankName,
      accountNumber: withdrawal.bank.accountNumber,
      accountName: withdrawal.bank.accountName,
    },
    status: withdrawal.status,
    rejectionReason: withdrawal.rejectionReason,
    createdAt: withdrawal.createdAt,
    paidAt: withdrawal.paidAt,
  };
}

export function listBanks() {
  return NG_BANKS;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export async function requestWithdrawal(user, params, meta = {}) {
  const { amountUsd, pin, totp, bankAccountId } = params;
  if (!paymentService.isConfigured()) {
    throw new ApiError(503, 'Payments are not configured on this server', 'GATEWAY_UNCONFIGURED');
  }

  // Resolve the destination: inline bank details if fully provided, otherwise a
  // saved account (explicit id, or the user's default when neither is given).
  const inlineBank = params.bankCode && params.accountNumber && params.accountName;
  const { bankCode, accountNumber, accountName } = inlineBank
    ? { bankCode: params.bankCode, accountNumber: params.accountNumber, accountName: params.accountName }
    : await bankAccountService.resolveForWithdrawal(user._id, bankAccountId);

  const settings = await settingsService.getSettings();
  if (!isWithinWithdrawalWindow(settings.withdrawal_days, settings.withdrawal_hours)) {
    throw ApiError.badRequest(
      `Withdrawals are only available ${settings.withdrawal_days}, ${settings.withdrawal_hours} (Lagos time)`,
      'WITHDRAWALS_CLOSED',
    );
  }

  const usdMicro = toSmallestUnits(amountUsd, PLATFORM_CURRENCY);
  const minMicro = toSmallestUnits(String(settings.min_withdrawal_usd), PLATFORM_CURRENCY);
  if (usdMicro < minMicro) {
    throw ApiError.badRequest(`Minimum withdrawal is $${settings.min_withdrawal_usd}`, 'BELOW_MINIMUM');
  }
  if (!NG_BANK_CODES.includes(bankCode)) {
    throw ApiError.badRequest('Unsupported bank', 'UNSUPPORTED_BANK');
  }

  // Daily limit, counted per Lagos calendar day (Lagos is UTC+1, no DST)
  const lagosMidnight = new Date(`${lagosDayKey()}T00:00:00+01:00`);
  const todayCount = await Withdrawal.countDocuments({
    user: user._id,
    createdAt: { $gte: lagosMidnight },
    status: { $in: ['pending', 'approved', 'paid'] },
  });
  if (todayCount >= settings.withdrawal_daily_limit) {
    throw ApiError.badRequest(
      `You can only withdraw ${settings.withdrawal_daily_limit} time(s) per day`,
      'DAILY_LIMIT_REACHED',
    );
  }

  await authService.verifyWithdrawalPin(user, pin);
  await authService.requireTotpIfEnabled(user, totp);

  // Fee tier + net, then NGN payout as WHOLE naira (Nigeria gateway rule)
  const thresholdMicro = toSmallestUnits(String(settings.withdrawal_fee_threshold_usd), PLATFORM_CURRENCY);
  const feePct = usdMicro < thresholdMicro ? settings.withdrawal_fee_pct_below : settings.withdrawal_fee_pct_above;
  const feeMicro = percentOf(usdMicro, feePct);
  const netMicro = usdMicro - feeMicro;
  const rate = await usdNgnRateKobo('withdrawal');
  const payoutNaira = usdMicroToNgnKobo(netMicro, rate) / 100n; // floor to whole naira
  if (netMicro <= 0n || payoutNaira <= 0n) {
    throw ApiError.badRequest('Amount too small after fees', 'AMOUNT_TOO_SMALL');
  }

  // Hold the GROSS dollars + create the record atomically
  const id = new mongoose.Types.ObjectId();
  const session = await mongoose.startSession();
  let withdrawal;
  try {
    await session.withTransaction(async () => {
      const { groupId } = await ledgerService.hold({
        user: user._id,
        currency: PLATFORM_CURRENCY,
        amount: usdMicro,
        type: 'withdrawal_hold',
        ref: { kind: 'Withdrawal', item: id },
        narration: `Withdrawal to ${bankCode} ${accountNumber}`,
        session,
      });
      [withdrawal] = await Withdrawal.create(
        [
          {
            _id: id,
            user: user._id,
            amount: bigIntToDecimal128(payoutNaira * 100n),
            fee: bigIntToDecimal128(feeMicro),
            amountUsd: bigIntToDecimal128(usdMicro),
            netAmountUsd: bigIntToDecimal128(netMicro),
            exchangeRate: bigIntToDecimal128(rate),
            bank: {
              bankCode,
              bankName: NG_BANKS.find((b) => b.code === bankCode)?.name ?? bankCode,
              accountNumber,
              accountName,
            },
            holdLedgerGroupId: groupId,
          },
        ],
        { session },
      );
    });
  } finally {
    await session.endSession();
  }

  // Submit the payout (outside the txn — network). Failure refunds immediately.
  try {
    const result = await paymentService.createPayoutOrder({
      merchantOrderId: `MS${id.toHexString()}`,
      amount: Number(payoutNaira),
      account: accountNumber,
      name: accountName,
      bnkCode: bankCode,
      ip: meta.ip,
    });
    if (!result.ok) {
      const reason = result.raw?.msg ?? 'Gateway rejected the payout';
      await refund(withdrawal, reason);
      throw ApiError.badRequest(`Withdrawal could not be processed: ${reason}`, 'GATEWAY_REJECTED');
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    await refund(withdrawal, `Gateway error: ${err.message}`);
    throw new ApiError(502, 'Payment gateway is temporarily unavailable — you were not charged', 'GATEWAY_ERROR');
  }

  withdrawal.status = 'approved'; // accepted by the gateway, processing
  withdrawal.autoApproved = true;
  await withdrawal.save();

  await notificationService.notifyUser(user._id, {
    type: 'withdrawal_status',
    title: 'Withdrawal submitted 📤',
    body: `Your withdrawal of $${fromSmallestUnits(usdMicro, PLATFORM_CURRENCY)} (net $${fromSmallestUnits(netMicro, PLATFORM_CURRENCY)} ≈ ₦${payoutNaira}) is being processed.`,
    meta: { withdrawalId: withdrawal.id },
  });
  await notificationService.notifyAdmins({
    type: 'withdrawal_pending',
    title: 'Withdrawal processing',
    body: `$${fromSmallestUnits(usdMicro, PLATFORM_CURRENCY)} payout to ${bankCode} ${accountNumber} submitted to the gateway.`,
    meta: { withdrawalId: withdrawal.id, user: String(user._id) },
  });

  return toDisplay(withdrawal);
}

// ---------------------------------------------------------------------------
// Settle / refund (idempotent via status guards — callback retries are safe)
// ---------------------------------------------------------------------------

async function refund(withdrawal, reason, adminUser) {
  if (!['pending', 'approved'].includes(withdrawal.status)) return withdrawal;

  const gross = decimal128ToBigInt(withdrawal.amountUsd);
  const { groupId } = await ledgerService.releaseHold({
    user: withdrawal.user,
    currency: PLATFORM_CURRENCY,
    amount: gross,
    type: 'withdrawal_release',
    ref: { kind: 'Withdrawal', item: withdrawal._id },
    narration: `Withdrawal refunded: ${reason}`,
    performedBy: adminUser?._id,
  });

  withdrawal.status = 'rejected';
  withdrawal.rejectionReason = reason;
  withdrawal.settlementLedgerGroupId = groupId;
  withdrawal.processedBy = adminUser?._id;
  withdrawal.processedAt = new Date();
  await withdrawal.save();

  await notificationService.notifyUser(withdrawal.user, {
    type: 'withdrawal_status',
    title: 'Withdrawal failed ❌',
    body: `Your withdrawal of $${fromSmallestUnits(gross, PLATFORM_CURRENCY)} could not be completed and has been refunded. Reason: ${reason}`,
    meta: { withdrawalId: withdrawal.id },
  });
  return withdrawal;
}

async function markPaid(withdrawal, adminUser) {
  if (withdrawal.status === 'paid') return withdrawal;
  if (!['pending', 'approved'].includes(withdrawal.status)) return withdrawal;

  const gross = decimal128ToBigInt(withdrawal.amountUsd);
  const { groupId } = await ledgerService.settleHold({
    user: withdrawal.user,
    currency: PLATFORM_CURRENCY,
    amount: gross,
    type: 'withdrawal',
    ref: { kind: 'Withdrawal', item: withdrawal._id },
    narration: `Paid ₦${fromSmallestUnits(decimal128ToBigInt(withdrawal.amount), 'NGN')} to ${withdrawal.bank.bankName} ${withdrawal.bank.accountNumber}`,
    performedBy: adminUser?._id,
  });

  withdrawal.status = 'paid';
  withdrawal.paidAt = new Date();
  withdrawal.settlementLedgerGroupId = groupId;
  withdrawal.processedBy = adminUser?._id;
  withdrawal.processedAt = new Date();
  await withdrawal.save();

  await notificationService.notifyUser(withdrawal.user, {
    type: 'withdrawal_status',
    title: 'Withdrawal completed ✅',
    body: `₦${fromSmallestUnits(decimal128ToBigInt(withdrawal.amount), 'NGN')} has been paid to your ${withdrawal.bank.bankName} account.`,
    meta: { withdrawalId: withdrawal.id },
  });
  return withdrawal;
}

// ---------------------------------------------------------------------------
// Callback (controller has already verified signature + source IP)
// ---------------------------------------------------------------------------

export async function handleCallback(body) {
  const merchantOrderId = String(body.merchantOrderId ?? '');
  if (!merchantOrderId.startsWith('MS')) return { handled: false };
  const withdrawal = await Withdrawal.findById(merchantOrderId.slice(2)).catch(() => null);
  if (!withdrawal) return { handled: false };

  if (body.orderId) withdrawal.payoutReference = String(body.orderId);

  const status = Number(body.orderStatus);
  if (status === paymentService.PAYOUT_STATUS.COMPLETED) {
    await markPaid(withdrawal);
  } else if (
    status === paymentService.PAYOUT_STATUS.FAILED ||
    status === paymentService.PAYOUT_STATUS.REFUNDED
  ) {
    await refund(withdrawal, body.remark || 'Payout failed at gateway');
  } else {
    await withdrawal.save(); // 1 processing / 2 frozen — keep reference, wait
  }
  return { handled: true };
}

// ---------------------------------------------------------------------------
// Reconciliation poller (callback fallback) — settles payouts whose callback
// was missed by querying the gateway. Skips orders younger than MIN_AGE (give
// the callback first) and older than MAX_AGE (abandoned). Started as a job.
// ---------------------------------------------------------------------------

const RECONCILE_MIN_AGE_MS = 3 * 60 * 1000;
const RECONCILE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const RECONCILE_BATCH = 50;

export async function reconcilePending() {
  if (!paymentService.isConfigured()) return { checked: 0, settled: 0 };
  const now = Date.now();
  const open = await Withdrawal.find({
    status: { $in: ['pending', 'approved'] },
    createdAt: { $lte: new Date(now - RECONCILE_MIN_AGE_MS), $gte: new Date(now - RECONCILE_MAX_AGE_MS) },
  })
    .sort({ createdAt: 1 })
    .limit(RECONCILE_BATCH);

  let settled = 0;
  for (const withdrawal of open) {
    let res;
    try {
      res = await paymentService.queryPayoutOrder(`MS${withdrawal.id}`);
    } catch (err) {
      logger.warn({ err, withdrawal: withdrawal.id }, 'Withdrawal reconcile query failed');
      continue;
    }
    const data = res?.data;
    if (res?.code !== 200 || !data) continue;
    if (data.orderId && !withdrawal.payoutReference) withdrawal.payoutReference = String(data.orderId);

    const status = Number(data.orderStatus);
    if (status === paymentService.PAYOUT_STATUS.COMPLETED) {
      await markPaid(withdrawal); // persists (incl. any orderId just set)
      settled += 1;
    } else if (
      status === paymentService.PAYOUT_STATUS.FAILED ||
      status === paymentService.PAYOUT_STATUS.REFUNDED
    ) {
      await refund(withdrawal, data.orderRemarks || 'Payout failed at gateway');
      settled += 1;
    } else if (withdrawal.isModified()) {
      await withdrawal.save(); // persist a newly-learned gateway orderId
    }
  }
  if (settled) logger.info({ settled, checked: open.length }, 'Withdrawal reconcile settled stuck orders');
  return { checked: open.length, settled };
}

// ---------------------------------------------------------------------------
// Reads + admin
// ---------------------------------------------------------------------------

export async function getHistory(userId, { status, ...query } = {}) {
  const filter = { user: userId };
  if (status) filter.status = status;

  const { page, limit, skip } = parsePagination(query);
  const [rows, total] = await Promise.all([
    Withdrawal.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Withdrawal.countDocuments(filter),
  ]);
  return { items: rows.map(toDisplay), meta: paginationMeta(total, page, limit) };
}

export async function adminList({ status, ...query } = {}) {
  const filter = status ? { status } : {};
  const { page, limit, skip } = parsePagination(query);
  const [rows, total] = await Promise.all([
    Withdrawal.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'email phone.e164 username'),
    Withdrawal.countDocuments(filter),
  ]);
  return {
    items: rows.map((w) => ({ ...toDisplay(w), user: w.user })),
    meta: paginationMeta(total, page, limit),
  };
}

/** Manual mark-paid (reconciliation: gateway paid but callback lost). */
export async function approve(adminUser, withdrawalId) {
  const withdrawal = await Withdrawal.findById(withdrawalId).catch(() => null);
  if (!withdrawal) throw ApiError.notFound('Withdrawal not found', 'WITHDRAWAL_NOT_FOUND');
  if (!['pending', 'approved'].includes(withdrawal.status)) {
    throw ApiError.conflict(`Cannot complete a ${withdrawal.status} withdrawal`, 'WITHDRAWAL_NOT_OPEN');
  }

  await markPaid(withdrawal, adminUser);
  await auditService.record({
    actor: adminUser,
    action: 'withdrawal.approve',
    target: { kind: 'Withdrawal', item: withdrawal._id },
  });
  return toDisplay(withdrawal);
}

export async function reject(adminUser, withdrawalId, reason) {
  const withdrawal = await Withdrawal.findById(withdrawalId).catch(() => null);
  if (!withdrawal) throw ApiError.notFound('Withdrawal not found', 'WITHDRAWAL_NOT_FOUND');
  if (!['pending', 'approved'].includes(withdrawal.status)) {
    throw ApiError.conflict(`Cannot reject a ${withdrawal.status} withdrawal`, 'WITHDRAWAL_NOT_OPEN');
  }

  await refund(withdrawal, reason || 'Rejected by admin', adminUser);
  await auditService.record({
    actor: adminUser,
    action: 'withdrawal.reject',
    target: { kind: 'Withdrawal', item: withdrawal._id },
    meta: { reason },
  });
  return toDisplay(withdrawal);
}
