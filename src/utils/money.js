import mongoose from 'mongoose';

// All amounts are handled as BigInt integers in the currency's smallest unit
// (NGN → kobo, USDT → micro-units, BTC → satoshi, ETH/BNB → wei) and persisted
// as Decimal128 integers. Floats never touch money.

export const CURRENCY_DECIMALS = {
  NGN: 2,
  USDT: 6,
  BTC: 8,
  ETH: 18,
  BNB: 18,
};

const AMOUNT_RE = /^\d+(\.\d+)?$/;

function decimalsFor(currency) {
  const decimals = CURRENCY_DECIMALS[currency];
  if (decimals === undefined) throw new RangeError(`Unknown currency: ${currency}`);
  return decimals;
}

/**
 * "1234.56" + "NGN" → 123456n. Rejects negatives, exponents, and more decimal
 * places than the currency supports (never silently rounds).
 */
export function toSmallestUnits(amount, currency) {
  const decimals = decimalsFor(currency);
  const s = String(amount).trim();
  if (!AMOUNT_RE.test(s)) throw new RangeError(`Invalid amount: "${amount}"`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) {
    throw new RangeError(`${currency} supports at most ${decimals} decimal places, got "${amount}"`);
  }
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

/** 123456n + "NGN" → "1234.56" (trailing zeros trimmed, but at least one fraction digit kept if nonzero). */
export function fromSmallestUnits(units, currency) {
  const decimals = decimalsFor(currency);
  let value = BigInt(units);
  const negative = value < 0n;
  if (negative) value = -value;
  const raw = value.toString().padStart(decimals + 1, '0');
  const whole = raw.slice(0, raw.length - decimals) || '0';
  const frac = decimals === 0 ? '' : raw.slice(raw.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Decimal128 (integer smallest units) → BigInt. */
export function decimal128ToBigInt(value) {
  if (value === null || value === undefined) return 0n;
  const s = value.toString();
  if (!/^-?\d+$/.test(s)) {
    throw new RangeError(`Expected integer smallest-units Decimal128, got "${s}"`);
  }
  return BigInt(s);
}

/** BigInt → Decimal128 for persistence. */
export function bigIntToDecimal128(value) {
  return mongoose.Types.Decimal128.fromString(BigInt(value).toString());
}

/** Sum BigInt amounts. */
export function addAmounts(...amounts) {
  return amounts.reduce((acc, a) => acc + BigInt(a), 0n);
}

/** a - b, throwing if the result would be negative (balances can never go below zero). */
export function subtractAmounts(a, b) {
  const result = BigInt(a) - BigInt(b);
  if (result < 0n) throw new RangeError('Amount subtraction would go negative');
  return result;
}

/** percent (e.g. 10 or 2.5) of a BigInt amount, floor-rounded to smallest units. */
export function percentOf(amount, percent) {
  const s = String(percent).trim();
  if (!AMOUNT_RE.test(s)) throw new RangeError(`Invalid percent: "${percent}"`);
  const [whole, frac = ''] = s.split('.');
  const scale = 10n ** BigInt(frac.length);
  const pct = BigInt(whole + frac);
  return (BigInt(amount) * pct) / (100n * scale);
}
