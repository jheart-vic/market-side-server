// ReferralService (SPEC §2.8) — 3-level commissions + share link/QR.
// Implemented so far: resolveReferrer (registration-time tree link).
//
// Still to implement:
//   payCommissions(event, sourceUser, baseAmountKobo, sourceRef)  → L1–L3 via LedgerService
//   getStats(user)                       → totals, active referrals, earnings per level
//   getShareLink(user) / getQrCode(user) → link + qrcode data-URL/PNG
//   getRates() / setRates(admin, rates)  (+ audit log)

import { User } from '../models/User.js';
import { REFERRAL_LEVELS } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';

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
