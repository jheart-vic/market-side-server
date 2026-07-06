// FX for the NGN rail (SPEC §2.2) — the USD↔NGN rate applied when deposits
// convert into the dollar balance and withdrawals convert back out.
// fx_mode 'live': USDT/NGN market price ± the admin spread (deposits pay a
// markup, withdrawals take a markdown — both platform revenue).
// fx_mode 'fixed': the admin-set NGN-per-USD rate, used as-is.

import * as priceService from './price.service.js';
import * as settingsService from './settings.service.js';
import { toSmallestUnits, percentOf } from '../utils/money.js';

/** Rate as integer kobo per 1 USD (BigInt). direction: 'deposit' | 'withdrawal'. */
export async function usdNgnRateKobo(direction) {
  const settings = await settingsService.getSettings();
  if (settings.fx_mode === 'fixed') {
    return toSmallestUnits(String(settings.fx_fixed_rate_ngn), 'NGN');
  }

  const market = await priceService.getPriceKobo('USDT/NGN');
  const spreadPct =
    direction === 'deposit' ? settings.deposit_spread_pct : settings.withdrawal_spread_pct;
  const adjustment = percentOf(market, spreadPct);
  return direction === 'deposit' ? market + adjustment : market - adjustment;
}

/** micro-USDT → NGN kobo at a kobo-per-USD rate. */
export const usdMicroToNgnKobo = (usdMicro, rateKobo) => (usdMicro * rateKobo) / 1_000_000n;

/** NGN kobo → micro-USDT at a kobo-per-USD rate. */
export const ngnKoboToUsdMicro = (ngnKobo, rateKobo) => (ngnKobo * 1_000_000n) / rateKobo;
