// SalaryService — referral "salary" tier rewards (client 2026-07-12).
//
// A member is QUALIFIED (non-intern) when, computed live: cumulative deposits
// ≥ $50, cumulative trade volume (spot + signal stakes) ≥ $50, AND current USD
// balance ≥ $50. A user's tier is driven by how many of their DIRECT (L1)
// referrals are qualified. Reaching a tier lets the (also-qualified) user claim
// a one-time reward — fulfilled MANUALLY (contact customer care); nothing is
// auto-credited. Everything except the claim record is derived on read, so a
// downgrade (someone's balance dropping below $50) reflects immediately.

import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Wallet } from '../models/Wallet.js';
import { Deposit } from '../models/Deposit.js';
import { Trade } from '../models/Trade.js';
import { SignalPosition } from '../models/SignalPosition.js';
import { SalaryClaim } from '../models/SalaryClaim.js';
import {
  PLATFORM_CURRENCY,
  SALARY_QUALIFY_USD,
  SALARY_TIERS,
} from '../config/constants.js';
import { CURRENCY_DECIMALS, decimal128ToBigInt } from '../utils/money.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import * as notificationService from './notification.service.js';
import * as auditService from './audit.service.js';

const oid = (id) => new mongoose.Types.ObjectId(String(id));

// $50 expressed in micro-USDT (PLATFORM_CURRENCY smallest units).
const QUALIFY_UNITS =
  BigInt(SALARY_QUALIFY_USD) * 10n ** BigInt(CURRENCY_DECIMALS[PLATFORM_CURRENCY]);

// ---------------------------------------------------------------------------
// Qualification
// ---------------------------------------------------------------------------

/** Sum one Decimal128 field grouped by user → Map<userId, BigInt smallest-units>. */
async function sumByUser(Model, match, field) {
  const rows = await Model.aggregate([
    { $match: match },
    { $group: { _id: '$user', total: { $sum: `$${field}` } } },
  ]);
  const map = new Map();
  for (const r of rows) map.set(String(r._id), decimal128ToBigInt(r.total));
  return map;
}

/**
 * Given user ids, return the Set of those who are QUALIFIED right now:
 * deposits ≥ $50 AND (spot + signal volume) ≥ $50 AND USD balance ≥ $50.
 * One batched pass over deposits/trades/signals/wallets so counting a large
 * downline stays a handful of aggregations, not N queries.
 */
export async function qualifiedIdSet(ids) {
  if (!ids?.length) return new Set();
  const objIds = ids.map(oid);

  const [deposits, trades, signals, wallets] = await Promise.all([
    sumByUser(Deposit, { user: { $in: objIds }, status: 'success' }, 'amountUsd'),
    sumByUser(Trade, { user: { $in: objIds } }, 'quoteAmount'),
    // exclude cancelled positions — their stake was refunded, so it isn't "traded"
    sumByUser(SignalPosition, { user: { $in: objIds }, status: { $ne: 'cancelled' } }, 'stake'),
    Wallet.find({ user: { $in: objIds }, currency: PLATFORM_CURRENCY }).select('user balance'),
  ]);

  const balance = new Map();
  for (const w of wallets) balance.set(String(w.user), decimal128ToBigInt(w.balance));

  const qualified = new Set();
  for (const id of ids) {
    const key = String(id);
    const dep = deposits.get(key) ?? 0n;
    const vol = (trades.get(key) ?? 0n) + (signals.get(key) ?? 0n);
    const bal = balance.get(key) ?? 0n;
    if (dep >= QUALIFY_UNITS && vol >= QUALIFY_UNITS && bal >= QUALIFY_UNITS) qualified.add(key);
  }
  return qualified;
}

export async function isQualified(userId) {
  const set = await qualifiedIdSet([userId]);
  return set.has(String(userId));
}

/** Direct (L1) referrals: how many exist and how many are currently qualified. */
export async function getValidDirects(userId) {
  const directs = await User.find({ referredBy: oid(userId) }).select('_id');
  const ids = directs.map((d) => d._id);
  const qualified = await qualifiedIdSet(ids);
  return { total: ids.length, valid: qualified.size };
}

// ---------------------------------------------------------------------------
// Tier / badge derivation
// ---------------------------------------------------------------------------

/** Highest tier index whose invite target is met by `validCount`, or -1 for none. */
function currentTier(validCount) {
  let tier = -1;
  for (const t of SALARY_TIERS) if (validCount >= t.invitees) tier = t.tier;
  return tier;
}

/** Badge ladder: intern (not qualified) → member (qualified, <tier0) → tierN. */
function badgeFor(qualified, validCount) {
  if (!qualified) return 'intern';
  const tier = currentTier(validCount);
  return tier < 0 ? 'member' : `tier${tier}`;
}

/** Lightweight badge for the profile card. */
export async function getBadge(userId) {
  const [qualified, directs] = await Promise.all([isQualified(userId), getValidDirects(userId)]);
  return {
    badge: badgeFor(qualified, directs.valid),
    tier: currentTier(directs.valid),
    qualified,
    validDirects: directs.valid,
    requiredUsd: SALARY_QUALIFY_USD,
  };
}

/** Full status for the Salary page: per-tier progress + claim state. */
export async function getStatus(userId) {
  const [qualified, directs, claims] = await Promise.all([
    isQualified(userId),
    getValidDirects(userId),
    SalaryClaim.find({ user: oid(userId) }).select('tier status'),
  ]);
  const validCount = directs.valid;
  const claimByTier = new Map(claims.map((c) => [c.tier, c.status]));

  const tiers = SALARY_TIERS.map((t) => {
    const claimStatus = claimByTier.get(t.tier) ?? null;
    const met = validCount >= t.invitees;
    const alreadyClaimed = claimStatus === 'pending' || claimStatus === 'fulfilled';
    return {
      tier: t.tier,
      reward: t.reward,
      rewardType: t.rewardType,
      required: t.invitees,
      current: Math.min(validCount, t.invitees),
      progressPct: Math.min(100, Math.floor((validCount / t.invitees) * 100)),
      met,
      claimStatus, // null | pending | fulfilled | rejected
      claimable: met && qualified && !alreadyClaimed,
    };
  });

  return {
    qualified,
    requiredUsd: SALARY_QUALIFY_USD,
    badge: badgeFor(qualified, validCount),
    tier: currentTier(validCount),
    directs: { total: directs.total, valid: validCount },
    tiers,
  };
}

// ---------------------------------------------------------------------------
// Claiming (manual fulfillment)
// ---------------------------------------------------------------------------

/** User claims a tier reward. Records a pending claim + notifies admins; no credit. */
export async function claim(user, tier, { name, phone } = {}) {
  const def = SALARY_TIERS.find((t) => t.tier === Number(tier));
  if (!def) throw ApiError.badRequest('Unknown salary tier', 'INVALID_TIER');
  if (!name || !phone) {
    throw ApiError.badRequest('Your name and phone number are required', 'CONTACT_REQUIRED');
  }

  const [qualified, directs] = await Promise.all([
    isQualified(user._id),
    getValidDirects(user._id),
  ]);
  if (!qualified) {
    throw ApiError.badRequest(
      `You must hold at least $${SALARY_QUALIFY_USD} and have traded $${SALARY_QUALIFY_USD}+ to claim`,
      'NOT_QUALIFIED',
    );
  }
  if (directs.valid < def.invitees) {
    throw ApiError.badRequest(
      `You need ${def.invitees} valid direct members to claim this reward`,
      'TARGET_NOT_MET',
    );
  }

  const existing = await SalaryClaim.findOne({
    user: user._id,
    tier: def.tier,
    status: { $in: ['pending', 'fulfilled'] },
  });
  if (existing) throw ApiError.conflict('You have already claimed this reward', 'ALREADY_CLAIMED');

  const row = await SalaryClaim.create({
    user: user._id,
    tier: def.tier,
    reward: def.reward,
    rewardType: def.rewardType,
    invitees: def.invitees,
    validDirectCount: directs.valid,
    contactName: String(name).trim(),
    contactPhone: String(phone).trim(),
  });

  // Confirm to the claimant, alert admins for fulfillment, and audit it so the
  // admin activity feed shows the claim the moment it happens.
  await notificationService.notifyUser(user._id, {
    type: 'salary_claim_status',
    title: 'Reward claim submitted',
    body: `Your Tier ${def.tier} reward (${def.reward}) claim was received. Please contact Customer Care with your name and phone number to receive it.`,
    meta: { claimId: row.id, tier: def.tier, status: 'pending' },
  });
  await notificationService.notifyAdmins({
    type: 'salary_claim',
    title: 'New salary reward claim',
    body: `${user.fullName || user.username || user.email} claimed Tier ${def.tier} (${def.reward}).`,
    meta: { claimId: row.id, tier: def.tier, user: user.id, contactName: row.contactName, contactPhone: row.contactPhone },
  });
  await auditService.record({
    actor: user,
    action: 'salary.claim',
    target: { kind: 'SalaryClaim', item: row._id },
    meta: { tier: def.tier, reward: def.reward, validDirectCount: directs.valid },
  });
  return row;
}

/** A user's own claim history. */
export async function myClaims(userId) {
  const rows = await SalaryClaim.find({ user: oid(userId) }).sort({ createdAt: -1 });
  return rows.map((c) => ({
    id: c.id,
    tier: c.tier,
    reward: c.reward,
    rewardType: c.rewardType,
    status: c.status,
    note: c.note,
    createdAt: c.createdAt,
    reviewedAt: c.reviewedAt,
  }));
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export async function adminList({ status, tier, ...query } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (tier !== undefined && tier !== '' && tier !== null) filter.tier = Number(tier);

  const { page, limit, skip } = parsePagination(query);
  const [rows, total] = await Promise.all([
    SalaryClaim.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'username fullName phone.e164 email'),
    SalaryClaim.countDocuments(filter),
  ]);

  const items = rows.map((c) => ({
    id: c.id,
    tier: c.tier,
    reward: c.reward,
    rewardType: c.rewardType,
    invitees: c.invitees,
    validDirectCount: c.validDirectCount,
    contactName: c.contactName,
    contactPhone: c.contactPhone,
    status: c.status,
    note: c.note,
    createdAt: c.createdAt,
    reviewedAt: c.reviewedAt,
    user: c.user && {
      id: c.user.id,
      username: c.user.username ?? null,
      fullName: c.user.fullName ?? null,
      phone: c.user.phone?.e164 ?? null,
      email: c.user.email ?? null,
    },
  }));
  return { items, meta: paginationMeta(total, page, limit) };
}

/** decision: 'fulfilled' | 'rejected' (note optional; used as rejection reason). */
export async function review(adminUser, claimId, decision, note) {
  if (!['fulfilled', 'rejected'].includes(decision)) {
    throw ApiError.badRequest('Decision must be fulfilled or rejected', 'INVALID_DECISION');
  }
  const claim = await SalaryClaim.findById(claimId);
  if (!claim) throw ApiError.notFound('Claim not found', 'CLAIM_NOT_FOUND');
  if (claim.status !== 'pending') {
    throw ApiError.conflict('This claim has already been reviewed', 'CLAIM_NOT_PENDING');
  }

  claim.status = decision;
  claim.reviewedBy = adminUser._id;
  claim.reviewedAt = new Date();
  if (note) claim.note = note;
  await claim.save();

  await notificationService.notifyUser(claim.user, {
    type: 'salary_claim_status',
    title: `Salary reward ${decision}`,
    body:
      decision === 'fulfilled'
        ? `Your Tier ${claim.tier} reward (${claim.reward}) has been fulfilled.`
        : `Your Tier ${claim.tier} reward claim was rejected${note ? `: ${note}` : ''}.`,
    meta: { claimId: claim.id, tier: claim.tier, status: decision },
  });
  // Keep the admin feed in sync so every admin sees the resolution, not just the actor.
  await notificationService.notifyAdmins({
    type: 'salary_claim',
    title: `Salary reward ${decision}`,
    body: `Tier ${claim.tier} (${claim.reward}) claim was ${decision} by ${adminUser.fullName || adminUser.username || adminUser.email}.`,
    meta: { claimId: claim.id, tier: claim.tier, status: decision, user: String(claim.user) },
  });
  await auditService.record({
    actor: adminUser,
    action: `salary.claim.${decision}`,
    target: { kind: 'SalaryClaim', item: claim._id },
    meta: { note },
  });
  return claim;
}
