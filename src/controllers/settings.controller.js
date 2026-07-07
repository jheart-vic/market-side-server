import * as settingsService from '../services/settings.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * GET /api/settings — the display-safe subset of platform settings any signed-in
 * user needs to show deposit/withdrawal rules (mins, fees, window). Internal
 * knobs (FX mode/spreads, spin internals) stay admin-only in GET /admin/settings.
 */
export const getPublicSettings = asyncHandler(async (_req, res) => {
  const s = await settingsService.getSettings();
  res.json({
    success: true,
    settings: {
      minDepositUsd: s.min_deposit_usd,
      minWithdrawalUsd: s.min_withdrawal_usd,
      withdrawalFeePctBelow: s.withdrawal_fee_pct_below,
      withdrawalFeePctAbove: s.withdrawal_fee_pct_above,
      withdrawalFeeThresholdUsd: s.withdrawal_fee_threshold_usd,
      withdrawalDays: s.withdrawal_days,
      withdrawalHours: s.withdrawal_hours,
      withdrawalDailyLimit: s.withdrawal_daily_limit,
    },
  });
});
