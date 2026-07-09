// SpinService — the Spin & Win wheel. The wheel renders 9 admin-configured
// prizes (settings: spin_prizes) but the outcome is fixed server-side: every
// spin wins the LOWEST value except each spin_bonus_every-th spin of the
// Lagos day platform-wide (global SpinCounter), which wins the SECOND lowest.
// Spins cost one credit; credits are earned when a direct (L1) referral
// registers, or granted by an admin. Prizes are paid in PLATFORM_CURRENCY
// through the ledger (`spin_reward`) — never a direct balance write.

import { User } from '../models/User.js';
import { Spin } from '../models/Spin.js';
import { SpinCounter } from '../models/SpinCounter.js';
import { PLATFORM_CURRENCY } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { lagosDayKey } from '../utils/time.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import {
  toSmallestUnits,
  fromSmallestUnits,
  bigIntToDecimal128,
  decimal128ToBigInt,
} from '../utils/money.js';
import * as settingsService from './settings.service.js';
import * as ledgerService from './ledger.service.js';
import * as notificationService from './notification.service.js';
import * as auditService from './audit.service.js';
import { sameLinkGroup } from './multiAccount.service.js';

/** Prize list as BigInt smallest units, in configured (wheel) order. */
async function wheelPrizes() {
  const settings = await settingsService.getSettings();
  const units = settings.spin_prizes.map((p) => toSmallestUnits(String(p), PLATFORM_CURRENCY));
  const sorted = [...units].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    units,
    lowest: sorted[0],
    secondLowest: sorted[1],
    bonusEvery: Number(settings.spin_bonus_every),
  };
}

/** Wheel config for the frontend circle + the caller's remaining credits. */
export async function getWheel(user) {
  const settings = await settingsService.getSettings();
  const fresh = await User.findById(user._id).select('spinCredits');
  return {
    prizes: settings.spin_prizes.map(String), // display dollars, wheel order
    currency: PLATFORM_CURRENCY,
    credits: fresh?.spinCredits ?? 0,
  };
}

/**
 * Play one spin: consume a credit (atomic conditional decrement), take the
 * next slot on the day's global counter, pay the decided prize via the
 * ledger, and record the Spin. Returns the wheel segment to animate to.
 */
export async function spin(user) {
  // 1) consume a credit — condition guards the race of concurrent spins
  const consumed = await User.findOneAndUpdate(
    { _id: user._id, spinCredits: { $gt: 0 } },
    { $inc: { spinCredits: -1 } },
    { new: true },
  );
  if (!consumed) {
    throw ApiError.badRequest('No spins left — earn one by inviting a friend', 'NO_SPIN_CREDITS');
  }

  try {
    const { units, lowest, secondLowest, bonusEvery } = await wheelPrizes();

    // 2) global daily counter decides the outcome: Nth spin of the day = bonus
    const dayKey = lagosDayKey();
    const counter = await SpinCounter.findOneAndUpdate(
      { dayKey },
      { $inc: { count: 1 } },
      { new: true, upsert: true },
    );
    const sequence = counter.count;
    const bonus = sequence % bonusEvery === 0;
    const amount = bonus ? secondLowest : lowest;
    const prizeIndex = units.findIndex((u) => u === amount);

    // 3) pay through the ledger and record the play
    const { groupId } = await ledgerService.credit({
      user: user._id,
      currency: PLATFORM_CURRENCY,
      amount,
      type: 'spin_reward',
      narration: `Spin & Win prize (${bonus ? 'bonus ' : ''}spin #${sequence} of ${dayKey})`,
    });
    const row = await Spin.create({
      user: user._id,
      dayKey,
      sequence,
      bonus,
      prizeIndex,
      amount: bigIntToDecimal128(amount),
      ledgerGroupId: groupId,
    });

    const prizeUsd = fromSmallestUnits(amount, PLATFORM_CURRENCY);
    await notificationService.notifyUser(user._id, {
      type: 'spin_reward',
      title: bonus ? 'Bonus spin — you won big! 🎉' : 'Spin & Win prize 🎡',
      body: `You won $${prizeUsd} on the wheel. It has been added to your balance.`,
      meta: { spinId: row.id, prizeUsd, bonus },
    });

    return { spinId: row.id, prizeIndex, prizeUsd, bonus, creditsLeft: consumed.spinCredits };
  } catch (err) {
    // the spin didn't happen — hand the consumed credit back
    await User.updateOne({ _id: user._id }, { $inc: { spinCredits: 1 } });
    throw err;
  }
}

export async function getHistory(userId, query = {}) {
  const { page, limit, skip } = parsePagination(query);
  const [rows, total] = await Promise.all([
    Spin.find({ user: userId }).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Spin.countDocuments({ user: userId }),
  ]);
  return {
    items: rows.map((s) => ({
      id: s.id,
      prizeUsd: fromSmallestUnits(decimal128ToBigInt(s.amount), PLATFORM_CURRENCY),
      prizeIndex: s.prizeIndex,
      bonus: s.bonus,
      createdAt: s.createdAt,
    })),
    meta: paginationMeta(total, page, limit),
  };
}

// ---------------------------------------------------------------------------
// Credit grants
// ---------------------------------------------------------------------------

/**
 * L1 referral reward hook — called from registration when the new user was
 * directly referred. Reads spin_referral_reward (0 disables the reward).
 */
export async function awardReferralSpin(uplineId, newUser) {
  const count = Number(await settingsService.getSetting('spin_referral_reward'));
  if (!Number.isInteger(count) || count <= 0) return 0;

  // Anti-abuse: don't reward a referral between accounts already linked in one
  // browser (self-referral). At registration the new user usually isn't linked
  // yet, so this only bites when a pre-existing link exists.
  const [upline, source] = await Promise.all([
    User.findById(uplineId).select('linkGroupId'),
    User.findById(newUser._id ?? newUser.id ?? newUser).select('linkGroupId'),
  ]);
  if (upline && source && sameLinkGroup(upline.linkGroupId, source.linkGroupId)) return 0;

  await User.updateOne({ _id: uplineId }, { $inc: { spinCredits: count } });
  await notificationService.notifyUser(uplineId, {
    type: 'spin_reward',
    title: 'You earned a spin! 🎡',
    body: `${newUser.username ?? 'Someone'} joined with your referral link — you got ${count} free spin${count > 1 ? 's' : ''} on the wheel.`,
    meta: { count, sourceUser: String(newUser._id) },
  });
  return count;
}

/** Admin grant (support/promotions) — audited, user notified. */
export async function grantCredits(adminUser, userId, count, reason) {
  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { spinCredits: count } },
    { new: true },
  );
  if (!user) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');

  await auditService.record({
    actor: adminUser,
    action: 'spin.grant',
    target: { kind: 'User', item: user._id },
    meta: { count, reason },
  });
  await notificationService.notifyUser(user._id, {
    type: 'spin_reward',
    title: 'Free spins added 🎡',
    body: `You received ${count} free spin${count > 1 ? 's' : ''} on the wheel. Reason: ${reason}`,
    meta: { count, reason },
  });
  return { userId: user.id, spinCredits: user.spinCredits };
}

// ---------------------------------------------------------------------------
// Admin view
// ---------------------------------------------------------------------------

export async function adminList({ day, user, ...query } = {}) {
  const filter = {};
  if (day) filter.dayKey = day;
  if (user) filter.user = user;

  const { page, limit, skip } = parsePagination(query);
  const [rows, total] = await Promise.all([
    Spin.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'email phone.e164 username'),
    Spin.countDocuments(filter),
  ]);
  return {
    items: rows.map((s) => ({
      id: s.id,
      user: s.user,
      dayKey: s.dayKey,
      sequence: s.sequence,
      bonus: s.bonus,
      prizeUsd: fromSmallestUnits(decimal128ToBigInt(s.amount), PLATFORM_CURRENCY),
      createdAt: s.createdAt,
    })),
    meta: paginationMeta(total, page, limit),
  };
}
