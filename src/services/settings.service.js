// SettingsService — admin-configurable platform knobs, persisted as one
// Setting row (key 'payment_settings') and merged over code defaults, so a
// fresh database works with zero setup. Cached in-process; setSettings is
// admin-only and audit-logged by the caller (admin controller).

import { Setting } from '../models/Setting.js';
import { ApiError } from '../utils/ApiError.js';
import * as auditService from './audit.service.js';

export const SETTINGS_KEY = 'payment_settings';

// Defaults mirror the client's running sister project.
export const DEFAULTS = {
  min_deposit_usd: 11.5,
  min_withdrawal_usd: 11.5,
  withdrawal_fee_pct_below: 16, // fee % when amount < threshold
  withdrawal_fee_pct_above: 10, // fee % when amount >= threshold
  withdrawal_fee_threshold_usd: 100,
  withdrawal_days: 'Monday to Sunday', // "Mon to Fri" range or "Monday,Wednesday" list
  withdrawal_hours: '08:00 AM – 10:00 PM', // Lagos wall-clock window
  withdrawal_daily_limit: 1, // requests per Lagos day
  fx_mode: 'live', // 'live' = USDT/NGN price ± spread · 'fixed' = fx_fixed_rate_ngn
  fx_fixed_rate_ngn: 1560, // NGN per USD when fx_mode = 'fixed'
  deposit_spread_pct: 0, // markup on the live rate when users buy USD
  withdrawal_spread_pct: 0, // markdown on the live rate when users sell USD
};

let cache = null;

export async function getSettings() {
  if (!cache) {
    const row = await Setting.findOne({ key: SETTINGS_KEY });
    cache = { ...DEFAULTS, ...(row?.value ?? {}) };
  }
  return cache;
}

export async function getSetting(name) {
  const settings = await getSettings();
  return settings[name];
}

/** Merge a partial update over the stored settings. Unknown keys are rejected. */
export async function setSettings(adminUser, patch) {
  const unknown = Object.keys(patch).filter((k) => !(k in DEFAULTS));
  if (unknown.length) {
    throw ApiError.badRequest(`Unknown settings: ${unknown.join(', ')}`, 'UNKNOWN_SETTINGS');
  }

  const current = await getSettings();
  const next = { ...current, ...patch };

  await Setting.findOneAndUpdate(
    { key: SETTINGS_KEY },
    { $set: { value: next, updatedBy: adminUser._id } },
    { upsert: true },
  );
  cache = next;

  await auditService.record({
    actor: adminUser,
    action: 'settings.update',
    meta: { patch },
  });
  return next;
}

/** Test hook / cache bust after external writes. */
export function clearSettingsCache() {
  cache = null;
}
