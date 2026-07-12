// DepositService (SPEC §2.3) — NGN deposit intent → gateway checkout → webhook
// verification (signature + IP, done by the payments controller) → ledger
// credit. Dollar platform: the exchange rate is LOCKED at intent; on the
// completed callback the actual paid NGN converts to USD at that locked rate in
// one ledger group (deposit credit NGN → conversion debit NGN → conversion
// credit USDT — the NGN wallet nets to zero). Idempotent via Deposit.status +
// the unique reference. Triggers referral commissions on the USD amount.

import mongoose from 'mongoose';
import { Deposit } from '../models/Deposit.js';
import { PLATFORM_CURRENCY } from '../config/constants.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import {
  toSmallestUnits,
  fromSmallestUnits,
  bigIntToDecimal128,
  decimal128ToBigInt,
} from '../utils/money.js';
import * as paymentService from './payment.service.js';
import * as settingsService from './settings.service.js';
import * as ledgerService from './ledger.service.js';
import * as referralService from './referral.service.js';
import * as notificationService from './notification.service.js';
import * as auditService from './audit.service.js';
import { usdNgnRateKobo, usdMicroToNgnKobo, ngnKoboToUsdMicro } from './fx.service.js';

function toDisplay(deposit) {
  const rate = deposit.exchangeRate ? decimal128ToBigInt(deposit.exchangeRate) : null;
  return {
    id: deposit.id,
    reference: deposit.reference, // our merchant order id (MS-prefixed)
    // Beidou platform order number — the transaction number shown in the log,
    // captured from the checkout URL at intent and confirmed on the callback
    gatewayOrderId: deposit.gatewayReference ?? null,
    amountNgn: fromSmallestUnits(decimal128ToBigInt(deposit.amount), 'NGN'),
    amountUsd: deposit.amountUsd
      ? fromSmallestUnits(decimal128ToBigInt(deposit.amountUsd), PLATFORM_CURRENCY)
      : null,
    exchangeRate: rate ? fromSmallestUnits(rate, 'NGN') : null, // NGN per $1
    status: deposit.status,
    createdAt: deposit.createdAt,
    creditedAt: deposit.creditedAt,
  };
}

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

/** amountUsd: display dollars ("50"). Returns the record + hosted checkout URL. */
export async function createIntent(user, { amountUsd }, meta = {}) {
  if (!paymentService.isConfigured()) {
    throw new ApiError(503, 'Payments are not configured on this server', 'GATEWAY_UNCONFIGURED');
  }

  const settings = await settingsService.getSettings();
  const usdMicro = toSmallestUnits(amountUsd, PLATFORM_CURRENCY);
  const minMicro = toSmallestUnits(String(settings.min_deposit_usd), PLATFORM_CURRENCY);
  if (usdMicro < minMicro) {
    throw ApiError.badRequest(`Minimum deposit is $${settings.min_deposit_usd}`, 'BELOW_MINIMUM');
  }

  const rate = await usdNgnRateKobo('deposit');
  // Collection amount must be whole naira — round half-up like the sister project
  const naira = (usdMicroToNgnKobo(usdMicro, rate) + 50n) / 100n;
  if (naira <= 0n) throw ApiError.badRequest('Amount too small', 'AMOUNT_TOO_SMALL');

  const id = new mongoose.Types.ObjectId();
  const reference = `MS${id.toHexString()}`; // 'MS' prefix: unique across projects on the shared merchant account
  const deposit = await Deposit.create({
    _id: id,
    user: user._id ?? user,
    gateway: 'beidou',
    reference,
    amount: bigIntToDecimal128(naira * 100n),
    amountUsd: bigIntToDecimal128(usdMicro),
    exchangeRate: bigIntToDecimal128(rate),
    channel: env.PG_DEPOSIT_PAYTYPE,
  });

  let result;
  try {
    result = await paymentService.createCollectionOrder({
      merchantOrderId: reference,
      amount: Number(naira),
      ip: meta.ip,
    });
  } catch (err) {
    deposit.status = 'failed';
    deposit.gatewayMeta = { error: err.message };
    await deposit.save();
    throw new ApiError(502, 'Payment gateway is temporarily unavailable', 'GATEWAY_ERROR');
  }

  if (!result.ok) {
    deposit.status = 'failed';
    deposit.gatewayMeta = result.raw;
    await deposit.save();
    throw ApiError.badRequest(
      `Could not start payment: ${result.raw?.msg ?? 'gateway rejected the order'}`,
      'GATEWAY_REJECTED',
    );
  }

  const orderIdMatch = String(result.payUrl).match(/orderId=([^&]+)/);
  if (orderIdMatch) deposit.gatewayReference = orderIdMatch[1];
  await deposit.save();

  return { ...toDisplay(deposit), payUrl: result.payUrl };
}

// ---------------------------------------------------------------------------
// Callback (controller has already verified signature + source IP)
// ---------------------------------------------------------------------------

export async function handleCallback(body) {
  const deposit = await Deposit.findOne({ reference: body.merchantOrderId });
  if (!deposit) return { handled: false }; // unknown order — controller still acks

  const status = Number(body.orderStatus);
  if (status === paymentService.COLLECTION_STATUS.COMPLETED) {
    await credit(deposit, body);
  } else if (
    status === paymentService.COLLECTION_STATUS.FAILED ||
    status === paymentService.COLLECTION_STATUS.REFUNDED
  ) {
    if (deposit.status === 'pending') {
      deposit.status = 'failed';
      deposit.gatewayMeta = body;
      await deposit.save();
    }
  }
  // 0 (init) / 1 (pending) → still in progress, just acknowledge
  return { handled: true };
}

// ---------------------------------------------------------------------------
// Reconciliation poller (callback fallback) — the gateway retries callbacks 8
// times then gives up, so a missed callback would strand a deposit as pending
// forever. This queries the gateway for still-pending orders and settles them
// with the same logic as the callback. Skips orders younger than MIN_AGE (give
// the callback first crack) and older than MAX_AGE (abandoned). Started as a job.
// ---------------------------------------------------------------------------

const RECONCILE_MIN_AGE_MS = 3 * 60 * 1000; // 3 min — let the live callback win first
const RECONCILE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days — stop chasing abandoned orders
const RECONCILE_BATCH = 50;

export async function reconcilePending() {
  if (!paymentService.isConfigured()) return { checked: 0, settled: 0 };
  const now = Date.now();
  const pending = await Deposit.find({
    status: 'pending',
    createdAt: { $lte: new Date(now - RECONCILE_MIN_AGE_MS), $gte: new Date(now - RECONCILE_MAX_AGE_MS) },
  })
    .sort({ createdAt: 1 })
    .limit(RECONCILE_BATCH);

  let settled = 0;
  for (const deposit of pending) {
    let res;
    try {
      res = await paymentService.queryCollectionOrder(deposit.reference);
    } catch (err) {
      logger.warn({ err, deposit: deposit.id }, 'Deposit reconcile query failed');
      continue;
    }
    const data = res?.data;
    if (res?.code !== 200 || !data) continue;
    if (data.orderId && !deposit.gatewayReference) deposit.gatewayReference = String(data.orderId);

    const status = Number(data.orderStatus);
    if (status === paymentService.COLLECTION_STATUS.COMPLETED) {
      await credit(deposit, data); // credit() persists (incl. any orderId just set)
      settled += 1;
    } else if (
      status === paymentService.COLLECTION_STATUS.FAILED ||
      status === paymentService.COLLECTION_STATUS.REFUNDED
    ) {
      deposit.status = 'failed';
      deposit.gatewayMeta = data;
      await deposit.save();
      settled += 1;
    } else if (deposit.isModified()) {
      await deposit.save(); // persist a newly-learned gateway orderId
    }
  }
  if (settled) logger.info({ settled, checked: pending.length }, 'Deposit reconcile settled stuck orders');
  return { checked: pending.length, settled };
}

/**
 * Credit a completed deposit: actual paid NGN (callback amount is
 * authoritative) converts to USD at the rate locked at intent. Idempotent —
 * an already-successful deposit is a no-op, so gateway retries are safe.
 */
async function credit(deposit, callbackBody) {
  if (deposit.status === 'success') return deposit;

  const rawAmt = String(callbackBody?.transAmt ?? '');
  const actualKobo = /^\d+(\.\d+)?$/.test(rawAmt)
    ? toSmallestUnits(rawAmt, 'NGN')
    : decimal128ToBigInt(deposit.amount);
  const rate = decimal128ToBigInt(deposit.exchangeRate);
  const usdMicro = ngnKoboToUsdMicro(actualKobo, rate);
  if (usdMicro <= 0n) {
    logger.error({ deposit: deposit.id, actualKobo: actualKobo.toString() }, 'Deposit credit: unusable amount');
    return deposit;
  }

  const ref = { kind: 'Deposit', item: deposit._id };
  const rateDisplay = fromSmallestUnits(rate, 'NGN');
  const { groupId } = await ledgerService.post([
    {
      user: deposit.user,
      currency: 'NGN',
      direction: 'credit',
      amount: actualKobo,
      type: 'deposit',
      ref,
      narration: 'Bank deposit via gateway',
    },
    {
      user: deposit.user,
      currency: 'NGN',
      direction: 'debit',
      amount: actualKobo,
      type: 'conversion',
      ref,
      narration: `Auto-convert to USD @ ₦${rateDisplay}/$`,
    },
    {
      user: deposit.user,
      currency: PLATFORM_CURRENCY,
      direction: 'credit',
      amount: usdMicro,
      type: 'conversion',
      ref,
      narration: `Deposit converted @ ₦${rateDisplay}/$`,
    },
  ]);

  deposit.status = 'success';
  deposit.creditedAt = new Date();
  deposit.ledgerGroupId = groupId;
  deposit.gatewayMeta = callbackBody;
  if (callbackBody?.orderId) deposit.gatewayReference = String(callbackBody.orderId);
  await deposit.save();

  // Commissions + notification must never fail the webhook ack
  try {
    await referralService.payCommissions({
      event: 'deposit',
      sourceUser: deposit.user,
      baseAmount: usdMicro,
      sourceRef: ref,
    });
  } catch (err) {
    logger.error({ err, deposit: deposit.id }, 'Referral commission payout failed');
  }
  await notificationService.notifyUser(deposit.user, {
    type: 'deposit_confirmed',
    title: 'Deposit credited ✅',
    body: `$${fromSmallestUnits(usdMicro, PLATFORM_CURRENCY)} has been credited to your balance (₦${fromSmallestUnits(actualKobo, 'NGN')} received).`,
    meta: { depositId: deposit.id, amountUsd: usdMicro.toString() },
  });

  return deposit;
}

// ---------------------------------------------------------------------------
// Reads + admin
// ---------------------------------------------------------------------------

export async function getHistory(userId, { status, ...query } = {}) {
  const filter = { user: userId };
  if (status) filter.status = status;

  const { page, limit, skip } = parsePagination(query);
  const [rows, total] = await Promise.all([
    Deposit.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Deposit.countDocuments(filter),
  ]);
  return { items: rows.map(toDisplay), meta: paginationMeta(total, page, limit) };
}

export async function adminList({ status, ...query } = {}) {
  const filter = status ? { status } : {};
  const { page, limit, skip } = parsePagination(query);
  const [rows, total] = await Promise.all([
    Deposit.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'email phone.e164 username'),
    Deposit.countDocuments(filter),
  ]);
  return {
    items: rows.map((d) => ({ ...toDisplay(d), user: d.user })),
    meta: paginationMeta(total, page, limit),
  };
}

/** Manual credit for reconciliation (e.g. gateway confirmed but callback lost). */
export async function manualApprove(adminUser, depositId) {
  const deposit = await Deposit.findById(depositId).catch(() => null);
  if (!deposit) throw ApiError.notFound('Deposit not found', 'DEPOSIT_NOT_FOUND');
  if (deposit.status !== 'pending') {
    throw ApiError.conflict(`Cannot approve a ${deposit.status} deposit`, 'DEPOSIT_NOT_PENDING');
  }

  await credit(deposit, { manual: true, by: String(adminUser._id) });
  await auditService.record({
    actor: adminUser,
    action: 'deposit.approve',
    target: { kind: 'Deposit', item: deposit._id },
  });
  return toDisplay(deposit);
}

export async function manualReject(adminUser, depositId, reason) {
  const deposit = await Deposit.findById(depositId).catch(() => null);
  if (!deposit) throw ApiError.notFound('Deposit not found', 'DEPOSIT_NOT_FOUND');
  if (deposit.status !== 'pending') {
    throw ApiError.conflict(`Cannot reject a ${deposit.status} deposit`, 'DEPOSIT_NOT_PENDING');
  }

  deposit.status = 'failed';
  deposit.gatewayMeta = { rejectedBy: String(adminUser._id), reason };
  await deposit.save();

  await auditService.record({
    actor: adminUser,
    action: 'deposit.reject',
    target: { kind: 'Deposit', item: deposit._id },
    meta: { reason },
  });
  await notificationService.notifyUser(deposit.user, {
    type: 'deposit_confirmed',
    title: 'Deposit rejected ❌',
    body: `Your deposit was rejected${reason ? `: ${reason}` : ''}.`,
    meta: { depositId: deposit.id },
  });
  return toDisplay(deposit);
}
