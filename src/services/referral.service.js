// ReferralService (SPEC §2.8) — 3-level commissions + share link/QR.
// Tree link happens at registration (resolveReferrer); commissions are paid in
// NGN through LedgerService when qualifying events (deposit, trade fee) occur.
// Rates default to constants but are admin-configurable, persisted in Setting.

import mongoose from 'mongoose';
import QRCode from 'qrcode';
import { User } from '../models/User.js';
import { Referral } from '../models/Referral.js';
import { Setting } from '../models/Setting.js';
import {
  REFERRAL_LEVELS,
  DEFAULT_REFERRAL_RATES,
  REFERRAL_EVENTS,
  PLATFORM_CURRENCY,
} from '../config/constants.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import {
  percentOf,
  fromSmallestUnits,
  bigIntToDecimal128,
  decimal128ToBigInt,
} from '../utils/money.js';
import * as ledgerService from './ledger.service.js';
import * as notificationService from './notification.service.js';
import * as auditService from './audit.service.js';
import { sameLinkGroup } from './multiAccount.service.js';

/**
 * Resolve a referral code into the tree fields stored on a new user:
 * referredBy = the code's owner, uplines = [L1, L2, L3] (nearest first),
 * denormalized so commission payout never walks the tree.
 */
export async function resolveReferrer(referralCode) {
  if (!referralCode) return { referredBy: null, uplines: [] };
  const referrer = await User.findOne({ referralCode: String(referralCode).trim().toUpperCase() });
  if (!referrer) throw ApiError.badRequest('Unknown referral code', 'INVALID_REFERRAL_CODE');
  return {
    referredBy: referrer._id,
    uplines: [referrer._id, ...referrer.uplines].slice(0, REFERRAL_LEVELS),
  };
}

// ---------------------------------------------------------------------------
// Rates (admin-configurable, persisted in Setting, cached in-process)
// ---------------------------------------------------------------------------

const RATES_KEY = 'referral_rates';
let ratesCache = null;

/** { 1: pct, 2: pct, 3: pct } */
export async function getRates() {
  if (!ratesCache) {
    const row = await Setting.findOne({ key: RATES_KEY });
    ratesCache = row?.value ?? { ...DEFAULT_REFERRAL_RATES };
  }
  return ratesCache;
}

export async function setRates(adminUser, rates) {
  const normalized = {};
  for (let level = 1; level <= REFERRAL_LEVELS; level++) {
    const pct = Number(rates?.[level]);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw ApiError.badRequest(`Rate for level ${level} must be 0–100`, 'INVALID_RATES');
    }
    normalized[level] = pct;
  }

  await Setting.findOneAndUpdate(
    { key: RATES_KEY },
    { $set: { value: normalized, updatedBy: adminUser._id } },
    { upsert: true },
  );
  ratesCache = normalized;

  await auditService.record({
    actor: adminUser,
    action: 'referral.rates.set',
    meta: { rates: normalized },
  });
  return normalized;
}

// ---------------------------------------------------------------------------
// Commission payout
// ---------------------------------------------------------------------------

/**
 * Pay L1–L3 commissions for a qualifying event. baseAmount is BigInt
 * PLATFORM_CURRENCY smallest units (micro-USDT) — the platform is
 * dollar-denominated, so deposits convert to USD before commissions are
 * computed. sourceRef: { kind, item } — the Deposit/Trade that triggered it.
 * Returns the Referral rows created.
 */
export async function payCommissions({ event, sourceUser, baseAmount, sourceRef }) {
  if (!REFERRAL_EVENTS.includes(event)) {
    throw ApiError.badRequest(`Unknown referral event: ${event}`, 'INVALID_REFERRAL_EVENT');
  }

  const source = await User.findById(sourceUser).select('uplines phone.e164 linkGroupId');
  if (!source || source.uplines.length === 0) return [];

  const rates = await getRates();
  const paid = [];

  // Anti-abuse: never pay commission to an upline that shares a multi-account
  // link group with the source (self-referral via linked accounts).
  const uplineGroups = new Map();
  if (source.linkGroupId) {
    const uplineDocs = await User.find({ _id: { $in: source.uplines } }).select('linkGroupId');
    for (const u of uplineDocs) uplineGroups.set(String(u._id), u.linkGroupId);
  }

  for (let i = 0; i < Math.min(source.uplines.length, REFERRAL_LEVELS); i++) {
    const level = i + 1;
    const ratePct = Number(rates[level] ?? 0);
    if (ratePct <= 0) continue;
    const amount = percentOf(baseAmount, ratePct);
    if (amount <= 0n) continue;

    const beneficiary = source.uplines[i];
    if (sameLinkGroup(source.linkGroupId, uplineGroups.get(String(beneficiary)))) {
      logger.info(
        { source: String(source._id), beneficiary: String(beneficiary), level },
        'referral commission skipped — linked accounts',
      );
      continue;
    }
    const { groupId } = await ledgerService.credit({
      user: beneficiary,
      currency: PLATFORM_CURRENCY,
      amount,
      type: 'referral_commission',
      ref: sourceRef,
      narration: `L${level} referral commission (${event}) from ${source.phone?.e164 ?? 'downline'}`,
    });

    const row = await Referral.create({
      beneficiary,
      sourceUser: source._id,
      level,
      event,
      ratePct,
      amount: bigIntToDecimal128(amount),
      sourceRef,
      ledgerGroupId: groupId,
    });

    await notificationService.notifyUser(beneficiary, {
      type: 'referral_commission',
      title: 'Referral commission earned',
      body: `You earned $${fromSmallestUnits(amount, PLATFORM_CURRENCY)} — level ${level} ${event.replace('_', ' ')} commission.`,
      meta: { referralId: row.id, level, event, amountUnits: amount.toString() },
    });
    paid.push(row);
  }
  return paid;
}

// ---------------------------------------------------------------------------
// Stats + share link / QR
// ---------------------------------------------------------------------------

export async function getStats(userId) {
  const id = new mongoose.Types.ObjectId(String(userId));
  const [totalReferrals, activeReferrals, earnings] = await Promise.all([
    User.countDocuments({ referredBy: id }),
    User.countDocuments({ referredBy: id, status: 'active' }),
    Referral.aggregate([
      { $match: { beneficiary: id } },
      { $group: { _id: '$level', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
  ]);

  const earningsByLevel = {};
  let totalUnits = 0n;
  for (let level = 1; level <= REFERRAL_LEVELS; level++) {
    const group = earnings.find((g) => g._id === level);
    const units = group ? decimal128ToBigInt(group.total) : 0n;
    totalUnits += units;
    earningsByLevel[level] = {
      amount: fromSmallestUnits(units, PLATFORM_CURRENCY), // dollars
      count: group?.count ?? 0,
    };
  }

  return {
    totalReferrals,
    activeReferrals,
    currency: PLATFORM_CURRENCY,
    earningsByLevel,
    totalEarnings: fromSmallestUnits(totalUnits, PLATFORM_CURRENCY),
  };
}

/** Mask a downline member's phone for display: +2348012345678 → +23480•••5678 */
function maskPhone(e164) {
  const s = String(e164 ?? '');
  if (s.length < 8) return s;
  return `${s.slice(0, 6)}•••${s.slice(-4)}`;
}

/**
 * Paginated downline members at one level. uplines is denormalized
 * nearest-first, so level-N members are users with uplines[N-1] === userId.
 */
export async function getMembers(userId, { level, ...query } = {}) {
  const id = new mongoose.Types.ObjectId(String(userId));
  // `uplines: id` hits the multikey index; the positional key pins the level.
  const filter = { uplines: id, [`uplines.${level - 1}`]: id };

  const { page, limit, skip } = parsePagination(query);
  const [rows, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('username fullName phone.e164 status kyc.status createdAt'),
    User.countDocuments(filter),
  ]);

  const items = rows.map((u) => ({
    id: u.id,
    username: u.username ?? null,
    fullName: u.fullName ?? null,
    phone: maskPhone(u.phone?.e164),
    status: u.status,
    kycStatus: u.kyc?.status,
    joinedAt: u.createdAt,
  }));
  return { items, meta: paginationMeta(total, page, limit) };
}

export function getShareLink(user) {
  return `${env.CLIENT_ORIGIN}/register?ref=${user.referralCode}`;
}

/** Server-generated QR (SPEC §2.8) — data-URL PNG for the frontend to render/download. */
export async function getQrCode(user) {
  const link = getShareLink(user);
  const qr = await QRCode.toDataURL(link, { margin: 1, width: 320 });
  return { link, referralCode: user.referralCode, qr };
}
