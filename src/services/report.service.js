// ReportService (SPEC §2.11) — admin analytics over the operational
// collections: an overview snapshot (users, deposits, withdrawals, trades,
// signal payouts, referral payouts) and per-metric daily time series. Money
// aggregates sum Decimal128 smallest units in Mongo and come back as display
// strings; days are bucketed on the Africa/Lagos calendar like every other
// time-window rule on the platform.

import { User } from '../models/User.js';
import { Deposit } from '../models/Deposit.js';
import { Withdrawal } from '../models/Withdrawal.js';
import { Trade } from '../models/Trade.js';
import { SignalPosition } from '../models/SignalPosition.js';
import { Referral } from '../models/Referral.js';
import { DEPOSIT_STATUS, WITHDRAWAL_STATUS, LAGOS_TZ, PLATFORM_CURRENCY } from '../config/constants.js';
import { decimal128ToBigInt, fromSmallestUnits } from '../utils/money.js';

const DAY_MS = 86_400_000;

// $sum over Decimal128 yields Decimal128 (or int 0 when nothing matched) —
// both stringify to an integer, which is what decimal128ToBigInt expects.
const big = (v) => (v == null ? 0n : decimal128ToBigInt(v));
const usd = (v) => fromSmallestUnits(big(v), PLATFORM_CURRENCY);
const ngn = (v) => fromSmallestUnits(big(v), 'NGN');

function rangeFilter({ from, to } = {}) {
  const createdAt = {};
  if (from) createdAt.$gte = new Date(from);
  if (to) createdAt.$lte = new Date(to);
  return Object.keys(createdAt).length ? { createdAt } : {};
}

// ---------------------------------------------------------------------------
// Overview — one call for the admin dashboard cards
// ---------------------------------------------------------------------------

export async function overview({ from, to } = {}) {
  const range = rangeFilter({ from, to });

  const [
    totalUsers,
    newUsers,
    frozenUsers,
    kycPending,
    depositRows,
    withdrawalRows,
    tradeRows,
    signalRows,
    referralRows,
  ] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments(range),
    User.countDocuments({ status: 'frozen' }),
    User.countDocuments({ 'kyc.status': 'pending' }),
    Deposit.aggregate([
      { $match: range },
      { $group: { _id: '$status', count: { $sum: 1 }, ngn: { $sum: '$amount' }, usd: { $sum: '$amountUsd' } } },
    ]),
    Withdrawal.aggregate([
      { $match: range },
      { $group: { _id: '$status', count: { $sum: 1 }, usd: { $sum: '$amountUsd' }, fees: { $sum: '$fee' } } },
    ]),
    Trade.aggregate([
      { $match: { status: 'filled', ...range } },
      { $group: { _id: null, count: { $sum: 1 }, volume: { $sum: '$quoteAmount' }, fees: { $sum: '$fee' } } },
    ]),
    SignalPosition.aggregate([
      { $match: range },
      {
        $group: {
          _id: { status: '$status', outcome: '$outcome' },
          count: { $sum: 1 },
          staked: { $sum: '$stake' },
          paidOut: { $sum: '$payout' },
        },
      },
    ]),
    Referral.aggregate([
      { $match: range },
      { $group: { _id: '$level', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
  ]);

  const deposits = Object.fromEntries(
    DEPOSIT_STATUS.map((s) => [s, { count: 0, amountNgn: '0', amountUsd: '0' }]),
  );
  for (const row of depositRows) {
    deposits[row._id] = { count: row.count, amountNgn: ngn(row.ngn), amountUsd: usd(row.usd) };
  }

  const withdrawals = Object.fromEntries(
    WITHDRAWAL_STATUS.map((s) => [s, { count: 0, amountUsd: '0', feesUsd: '0' }]),
  );
  for (const row of withdrawalRows) {
    withdrawals[row._id] = { count: row.count, amountUsd: usd(row.usd), feesUsd: usd(row.fees) };
  }

  const trade = tradeRows[0];
  const trades = {
    count: trade?.count ?? 0,
    volumeUsd: usd(trade?.volume),
    feesUsd: usd(trade?.fees),
  };

  // Open stakes are still escrowed; settled splits into wins (stake + return
  // paid out) and losses (stake forfeited). House net = staked − paid out.
  const signals = {
    open: { count: 0, stakedUsd: '0' },
    settled: { count: 0, wins: 0, losses: 0 },
    cancelled: { count: 0, refundedUsd: '0' },
  };
  let settledStaked = 0n;
  let settledPaidOut = 0n;
  for (const row of signalRows) {
    const { status, outcome } = row._id;
    if (status === 'open') {
      signals.open = { count: row.count, stakedUsd: usd(row.staked) };
    } else if (status === 'cancelled') {
      signals.cancelled = { count: row.count, refundedUsd: usd(row.staked) };
    } else if (status === 'settled') {
      signals.settled.count += row.count;
      if (outcome === 'win') signals.settled.wins += row.count;
      if (outcome === 'lose') signals.settled.losses += row.count;
      settledStaked += big(row.staked);
      settledPaidOut += big(row.paidOut);
    }
  }
  signals.settled.stakedUsd = fromSmallestUnits(settledStaked, PLATFORM_CURRENCY);
  signals.settled.paidOutUsd = fromSmallestUnits(settledPaidOut, PLATFORM_CURRENCY);
  signals.settled.houseNetUsd = fromSmallestUnits(settledStaked - settledPaidOut, PLATFORM_CURRENCY);

  const byLevel = {};
  let referralCount = 0;
  let referralTotal = 0n;
  for (const row of referralRows) {
    byLevel[row._id] = { count: row.count, amountUsd: usd(row.amount) };
    referralCount += row.count;
    referralTotal += big(row.amount);
  }
  const referrals = {
    count: referralCount,
    totalUsd: fromSmallestUnits(referralTotal, PLATFORM_CURRENCY),
    byLevel,
  };

  return {
    range: { from: from ?? null, to: to ?? null },
    users: { total: totalUsers, newInRange: newUsers, frozen: frozenUsers, kycPending },
    deposits,
    withdrawals,
    trades,
    signals,
    referrals,
  };
}

// ---------------------------------------------------------------------------
// Time series — daily buckets for the dashboard charts
// ---------------------------------------------------------------------------

const METRIC_SOURCES = {
  users: { model: User, match: {} }, // registrations; count only
  deposits: { model: Deposit, match: { status: 'success' }, volume: '$amountUsd' },
  withdrawals: { model: Withdrawal, match: { status: 'paid' }, volume: '$amountUsd' },
  trades: { model: Trade, match: { status: 'filled' }, volume: '$quoteAmount' },
  signal_payouts: { model: SignalPosition, match: { status: 'settled' }, volume: '$payout' },
  referral_payouts: { model: Referral, match: {}, volume: '$amount' },
};

export const REPORT_METRICS = Object.keys(METRIC_SOURCES);

/** Defaults to the last 30 days. Points only exist for days with activity. */
export async function timeseries({ metric, from, to } = {}) {
  const source = METRIC_SOURCES[metric];
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * DAY_MS);

  const group = {
    _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: LAGOS_TZ } },
    count: { $sum: 1 },
  };
  if (source.volume) group.volume = { $sum: source.volume };

  const rows = await source.model.aggregate([
    { $match: { ...source.match, createdAt: { $gte: start, $lte: end } } },
    { $group: group },
    { $sort: { _id: 1 } },
  ]);

  return {
    metric,
    from: start,
    to: end,
    points: rows.map((row) => ({
      day: row._id,
      count: row.count,
      ...(source.volume && { volumeUsd: usd(row.volume) }),
    })),
  };
}
