// SignalService (SPEC §2.7) — admin-published "contract order" signals with a
// binary-options mechanic: the user stakes dollars and picks CALL/PUT; entry
// and settlement prices (NGN-quoted, from our own PriceService cache) decide
// win (stake + fixed return %) or loss (full stake forfeited — no tie: an
// unchanged price counts as a loss). Release job publishes scheduled signals
// daily within 15:00–17:00 Africa/Lagos; contracts may only be placed inside
// each signal's own trading window. Stakes are held via LedgerService; the
// unique (user, signal) index enforces one contract per user per signal.

import mongoose from 'mongoose';
import { Signal } from '../models/Signal.js';
import { SignalPosition } from '../models/SignalPosition.js';
import {
  SIGNAL_PAIRS,
  SIGNAL_DIRECTIONS,
  PLATFORM_CURRENCY,
} from '../config/constants.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import { lagosParts, lagosDayKey, isWithinSignalWindow } from '../utils/time.js';
import {
  toSmallestUnits,
  fromSmallestUnits,
  bigIntToDecimal128,
  decimal128ToBigInt,
  percentOf,
} from '../utils/money.js';
import * as priceService from './price.service.js';
import * as ledgerService from './ledger.service.js';
import * as notificationService from './notification.service.js';
import * as auditService from './audit.service.js';

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** True while the Lagos wall clock sits inside the signal's trading window. */
export function isInTradingWindow(signal, date = new Date()) {
  const { hour, minute } = lagosParts(date);
  const now = hour * 60 + minute;
  return now >= minutesOf(signal.tradingStart) && now < minutesOf(signal.tradingEnd);
}

function toDisplaySignal(signal) {
  return {
    id: signal.id,
    pair: signal.pair,
    direction: signal.direction,
    returnPct: signal.returnPct,
    minStake: fromSmallestUnits(decimal128ToBigInt(signal.minStake), PLATFORM_CURRENCY),
    maxStake: fromSmallestUnits(decimal128ToBigInt(signal.maxStake), PLATFORM_CURRENCY),
    currency: PLATFORM_CURRENCY,
    durationSeconds: signal.durationSeconds,
    tradingStart: signal.tradingStart,
    tradingEnd: signal.tradingEnd,
    releaseDay: signal.releaseDay,
    releasedAt: signal.releasedAt,
    status: signal.status,
    inTradingWindow: signal.status === 'released' && isInTradingWindow(signal),
  };
}

function toDisplayPosition(position) {
  return {
    id: position.id,
    signal: position.signal?.pair
      ? {
          id: position.signal.id,
          pair: position.signal.pair,
          direction: position.signal.direction,
          durationSeconds: position.signal.durationSeconds,
        }
      : position.signal,
    direction: position.direction,
    stake: fromSmallestUnits(decimal128ToBigInt(position.stake), PLATFORM_CURRENCY),
    currency: PLATFORM_CURRENCY,
    returnPct: position.returnPct,
    entryPrice: fromSmallestUnits(decimal128ToBigInt(position.entryPrice), 'NGN'),
    settlePrice:
      position.settlePrice == null
        ? null
        : fromSmallestUnits(decimal128ToBigInt(position.settlePrice), 'NGN'),
    outcome: position.outcome,
    payout:
      position.payout == null
        ? null
        : fromSmallestUnits(decimal128ToBigInt(position.payout), PLATFORM_CURRENCY),
    status: position.status,
    settlesAt: position.settlesAt,
    settledAt: position.settledAt,
    createdAt: position.createdAt,
  };
}

async function mustFindSignal(id) {
  const signal = await Signal.findById(id).catch(() => null);
  if (!signal) throw ApiError.notFound('Signal not found', 'SIGNAL_NOT_FOUND');
  return signal;
}

// ---------------------------------------------------------------------------
// Admin CRUD
// ---------------------------------------------------------------------------

/** Stakes come in display dollars (e.g. "10"); releaseDay defaults to today (Lagos). */
export async function createSignal(admin, data) {
  const {
    pair,
    direction,
    returnPct,
    minStake,
    maxStake,
    durationSeconds,
    tradingStart,
    tradingEnd,
    releaseDay = lagosDayKey(),
  } = data;

  if (!SIGNAL_PAIRS.includes(pair)) throw ApiError.badRequest(`Pair must be one of: ${SIGNAL_PAIRS.join(', ')}`, 'INVALID_PAIR');
  if (!SIGNAL_DIRECTIONS.includes(direction)) throw ApiError.badRequest('Direction must be call or put', 'INVALID_DIRECTION');
  if (!HHMM_RE.test(tradingStart) || !HHMM_RE.test(tradingEnd) || minutesOf(tradingStart) >= minutesOf(tradingEnd)) {
    throw ApiError.badRequest('Trading window must be valid HH:mm with start before end', 'INVALID_WINDOW');
  }
  if (!DAY_RE.test(releaseDay)) throw ApiError.badRequest('releaseDay must be YYYY-MM-DD', 'INVALID_DAY');

  const min = toSmallestUnits(minStake, PLATFORM_CURRENCY);
  const max = toSmallestUnits(maxStake, PLATFORM_CURRENCY);
  if (min <= 0n || max < min) throw ApiError.badRequest('Stake bounds invalid (min > 0, max >= min)', 'INVALID_STAKES');

  const signal = await Signal.create({
    pair,
    direction,
    returnPct,
    minStake: bigIntToDecimal128(min),
    maxStake: bigIntToDecimal128(max),
    durationSeconds,
    tradingStart,
    tradingEnd,
    releaseDay,
    createdBy: admin._id,
  });
  await auditService.record({
    actor: admin,
    action: 'signal.create',
    target: { kind: 'Signal', item: signal._id },
    meta: { pair, direction, returnPct, releaseDay },
  });
  return toDisplaySignal(signal);
}

/** Editable only while still scheduled — released signals may already have money on them. */
export async function updateSignal(admin, id, patch) {
  const signal = await mustFindSignal(id);
  if (signal.status !== 'scheduled') {
    throw ApiError.conflict('Only scheduled signals can be edited', 'SIGNAL_NOT_EDITABLE');
  }

  const editable = ['pair', 'direction', 'returnPct', 'durationSeconds', 'tradingStart', 'tradingEnd', 'releaseDay'];
  for (const key of editable) {
    if (patch[key] !== undefined) signal[key] = patch[key];
  }
  if (patch.minStake !== undefined) signal.minStake = bigIntToDecimal128(toSmallestUnits(patch.minStake, PLATFORM_CURRENCY));
  if (patch.maxStake !== undefined) signal.maxStake = bigIntToDecimal128(toSmallestUnits(patch.maxStake, PLATFORM_CURRENCY));
  if (minutesOf(signal.tradingStart) >= minutesOf(signal.tradingEnd)) {
    throw ApiError.badRequest('Trading window must have start before end', 'INVALID_WINDOW');
  }
  await signal.save();

  await auditService.record({
    actor: admin,
    action: 'signal.update',
    target: { kind: 'Signal', item: signal._id },
    meta: { patch: Object.keys(patch) },
  });
  return toDisplaySignal(signal);
}

/** Cancel a scheduled/released signal; open positions are refunded in full. */
export async function cancelSignal(admin, id, reason) {
  const signal = await mustFindSignal(id);
  if (!['scheduled', 'released'].includes(signal.status)) {
    throw ApiError.conflict(`Cannot cancel a ${signal.status} signal`, 'SIGNAL_NOT_CANCELLABLE');
  }

  signal.status = 'cancelled';
  await signal.save();

  const openPositions = await SignalPosition.find({ signal: signal._id, status: 'open' });
  for (const position of openPositions) {
    const stake = decimal128ToBigInt(position.stake);
    // held → balance: full refund (type signal_stake, credit direction)
    const { groupId } = await ledgerService.releaseHold({
      user: position.user,
      currency: PLATFORM_CURRENCY,
      amount: stake,
      type: 'signal_stake',
      ref: { kind: 'SignalPosition', item: position._id },
      narration: `Signal ${signal.pair} cancelled — stake refunded`,
      performedBy: admin._id,
    });
    position.status = 'cancelled';
    position.settlementLedgerGroupId = groupId;
    position.settledAt = new Date();
    await position.save();

    await notificationService.notifyUser(position.user, {
      type: 'signal_settled',
      title: 'Signal cancelled — stake refunded',
      body: `The ${signal.pair} signal was cancelled. Your $${fromSmallestUnits(stake, PLATFORM_CURRENCY)} stake has been refunded.`,
      meta: { signalId: signal.id, positionId: position.id, refund: true },
    });
  }

  await auditService.record({
    actor: admin,
    action: 'signal.cancel',
    target: { kind: 'Signal', item: signal._id },
    meta: { reason, refundedPositions: openPositions.length },
  });
  return { id: signal.id, status: signal.status, refundedPositions: openPositions.length };
}

// ---------------------------------------------------------------------------
// Release job
// ---------------------------------------------------------------------------

/**
 * Publish today's scheduled signals — only fires inside the 15:00–17:00 Lagos
 * release window (pass force:true for a manual admin release outside it).
 */
export async function releaseDueSignals({ force = false } = {}) {
  if (!force && !isWithinSignalWindow()) return { released: 0 };

  const due = await Signal.find({ status: 'scheduled', releaseDay: lagosDayKey() });
  for (const signal of due) {
    signal.status = 'released';
    signal.releasedAt = new Date();
    await signal.save();
    // Socket broadcast only — a Notification row per user per signal would flood
    // the collection daily; the signals screen is the canonical list.
    notificationService.broadcast('signal_released', toDisplaySignal(signal));
  }
  if (due.length) logger.info({ count: due.length }, 'Signals released');
  return { released: due.length };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** Today's released signals (the user-facing "contract order" screen). */
export async function listActive() {
  const signals = await Signal.find({ status: 'released', releaseDay: lagosDayKey() }).sort({ releasedAt: -1 });
  return signals.map(toDisplaySignal);
}

/** Admin: every signal for a Lagos day, any status. */
export async function listForDay(dayKey = lagosDayKey(), query = {}) {
  const { page, limit, skip } = parsePagination(query);
  const filter = { releaseDay: dayKey };
  const [signals, total] = await Promise.all([
    Signal.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Signal.countDocuments(filter),
  ]);
  return { items: signals.map(toDisplaySignal), meta: paginationMeta(total, page, limit) };
}

// ---------------------------------------------------------------------------
// Placing a contract order
// ---------------------------------------------------------------------------

/**
 * stake: display dollars ("10"); direction: the user's own call/put choice.
 * Stake is held via ledger and the entry price snapshotted atomically.
 */
export async function placeOrder(user, signalId, { stake, direction }) {
  const signal = await mustFindSignal(signalId);
  if (signal.status !== 'released') {
    throw ApiError.conflict('Signal is not open for orders', 'SIGNAL_NOT_OPEN');
  }
  if (!isInTradingWindow(signal)) {
    throw ApiError.conflict(
      `Orders are only accepted ${signal.tradingStart}–${signal.tradingEnd} (Lagos time)`,
      'OUTSIDE_TRADING_WINDOW',
    );
  }
  if (!SIGNAL_DIRECTIONS.includes(direction)) {
    throw ApiError.badRequest('Direction must be call or put', 'INVALID_DIRECTION');
  }

  const userId = user._id ?? user;
  const stakeUnits = toSmallestUnits(stake, PLATFORM_CURRENCY);
  const min = decimal128ToBigInt(signal.minStake);
  const max = decimal128ToBigInt(signal.maxStake);
  if (stakeUnits < min || stakeUnits > max) {
    throw ApiError.badRequest(
      `Stake must be between $${fromSmallestUnits(min, PLATFORM_CURRENCY)} and $${fromSmallestUnits(max, PLATFORM_CURRENCY)}`,
      'STAKE_OUT_OF_BOUNDS',
    );
  }

  const entryPrice = await priceService.getPriceKobo(signal.pair);

  const session = await mongoose.startSession();
  try {
    let position;
    await session.withTransaction(async () => {
      [position] = await SignalPosition.create(
        [
          {
            user: userId,
            signal: signal._id,
            stake: bigIntToDecimal128(stakeUnits),
            direction,
            returnPct: signal.returnPct,
            entryPrice: bigIntToDecimal128(entryPrice),
            settlesAt: new Date(Date.now() + signal.durationSeconds * 1000),
          },
        ],
        { session },
      );
      const { groupId } = await ledgerService.hold({
        user: userId,
        currency: PLATFORM_CURRENCY,
        amount: stakeUnits,
        type: 'signal_stake',
        ref: { kind: 'SignalPosition', item: position._id },
        narration: `Contract order ${signal.pair} ${direction} (${signal.durationSeconds}s)`,
        session,
      });
      position.stakeLedgerGroupId = groupId;
      await position.save({ session });
    });
    return toDisplayPosition(position);
  } catch (err) {
    if (err?.code === 11000) {
      throw ApiError.conflict('You have already taken this signal', 'ALREADY_JOINED');
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// Settlement job
// ---------------------------------------------------------------------------

/**
 * Sweep due open positions: snapshot the settle price, decide win/lose, and
 * write the ledger settlement. Right direction → stake + return %; wrong or
 * unchanged → stake forfeited. Each position settles independently so one
 * failure never blocks the sweep.
 */
export async function settleDuePositions(now = new Date()) {
  const due = await SignalPosition.find({ status: 'open', settlesAt: { $lte: now } }).populate(
    'signal',
    'pair direction durationSeconds',
  );

  let settled = 0;
  for (const position of due) {
    try {
      const settlePrice = await priceService.getPriceKobo(position.signal.pair);
      const entry = decimal128ToBigInt(position.entryPrice);
      const stake = decimal128ToBigInt(position.stake);
      const won =
        (position.direction === 'call' && settlePrice > entry) ||
        (position.direction === 'put' && settlePrice < entry); // equal price = loss (no tie)
      const payout = won ? stake + percentOf(stake, position.returnPct) : 0n;

      const entries = [
        {
          // consume the held stake
          user: position.user,
          currency: PLATFORM_CURRENCY,
          direction: 'debit',
          amount: stake,
          type: 'signal_settlement',
          ref: { kind: 'SignalPosition', item: position._id },
          narration: `Contract ${position.signal.pair} ${position.direction} — ${won ? 'won' : 'lost'}`,
        },
        ...(won
          ? [
              {
                user: position.user,
                currency: PLATFORM_CURRENCY,
                direction: 'credit',
                amount: payout,
                type: 'signal_settlement',
                ref: { kind: 'SignalPosition', item: position._id },
                narration: `Contract ${position.signal.pair} payout (stake + ${position.returnPct}%)`,
              },
            ]
          : []),
      ];
      const { groupId } = await ledgerService.post(entries);

      position.settlePrice = bigIntToDecimal128(settlePrice);
      position.outcome = won ? 'win' : 'lose';
      position.payout = bigIntToDecimal128(payout);
      position.status = 'settled';
      position.settledAt = new Date();
      position.settlementLedgerGroupId = groupId;
      await position.save();
      settled += 1;

      await notificationService.notifyUser(position.user, {
        type: 'signal_settled',
        title: won ? 'Contract won 🎉' : 'Contract lost',
        body: won
          ? `Your ${position.signal.pair} ${position.direction} contract won — $${fromSmallestUnits(payout, PLATFORM_CURRENCY)} credited.`
          : `Your ${position.signal.pair} ${position.direction} contract lost — $${fromSmallestUnits(stake, PLATFORM_CURRENCY)} stake forfeited.`,
        meta: { positionId: position.id, outcome: position.outcome, payout: payout.toString() },
      });
    } catch (err) {
      logger.error({ err, position: position.id }, 'Signal settlement failed; will retry next sweep');
    }
  }

  // A released signal whose day has passed and whose positions are all settled is done
  const stillOpen = await SignalPosition.distinct('signal', { status: 'open' });
  await Signal.updateMany(
    { status: 'released', releaseDay: { $lt: lagosDayKey(now) }, _id: { $nin: stillOpen } },
    { $set: { status: 'settled', settledAt: now } },
  );

  return { settled, due: due.length };
}

// ---------------------------------------------------------------------------
// User history
// ---------------------------------------------------------------------------

export async function getPositions(userId, { status, ...query } = {}) {
  const filter = { user: userId };
  if (status) filter.status = status;

  const { page, limit, skip } = parsePagination(query);
  const [rows, total] = await Promise.all([
    SignalPosition.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('signal', 'pair direction durationSeconds'),
    SignalPosition.countDocuments(filter),
  ]);
  return { items: rows.map(toDisplayPosition), meta: paginationMeta(total, page, limit) };
}
