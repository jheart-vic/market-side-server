import { describe, it, expect } from 'vitest';
import {
  toSmallestUnits,
  fromSmallestUnits,
  bigIntToDecimal128,
  decimal128ToBigInt,
  addAmounts,
  subtractAmounts,
  percentOf,
  CURRENCY_DECIMALS,
} from '../src/utils/money.js';

describe('toSmallestUnits', () => {
  it('converts display amounts to integer smallest units', () => {
    expect(toSmallestUnits('1234.56', 'NGN')).toBe(123456n);
    expect(toSmallestUnits('1', 'USDT')).toBe(1_000_000n);
    expect(toSmallestUnits('0.00000001', 'BTC')).toBe(1n); // 1 satoshi
    expect(toSmallestUnits('1', 'ETH')).toBe(10n ** 18n); // 1 wei * 10^18
    expect(toSmallestUnits('0.5', 'USDT')).toBe(500_000n);
  });

  it('rejects more decimals than the currency supports (never rounds)', () => {
    expect(() => toSmallestUnits('1.234', 'NGN')).toThrow(RangeError);
    expect(() => toSmallestUnits('0.0000001', 'USDT')).toThrow(RangeError);
  });

  it('rejects negatives, exponents, and junk', () => {
    expect(() => toSmallestUnits('-5', 'NGN')).toThrow(RangeError);
    expect(() => toSmallestUnits('1e6', 'NGN')).toThrow(RangeError);
    expect(() => toSmallestUnits('abc', 'NGN')).toThrow(RangeError);
    expect(() => toSmallestUnits('', 'NGN')).toThrow(RangeError);
  });

  it('rejects unknown currencies', () => {
    expect(() => toSmallestUnits('1', 'DOGE')).toThrow(RangeError);
  });
});

describe('fromSmallestUnits', () => {
  it('renders display strings with trailing zeros trimmed', () => {
    expect(fromSmallestUnits(123456n, 'NGN')).toBe('1234.56');
    expect(fromSmallestUnits(1_000_000n, 'USDT')).toBe('1');
    expect(fromSmallestUnits(500_000n, 'USDT')).toBe('0.5');
    expect(fromSmallestUnits(0n, 'NGN')).toBe('0');
    expect(fromSmallestUnits(-123456n, 'NGN')).toBe('-1234.56');
  });

  it('round-trips every currency', () => {
    for (const currency of Object.keys(CURRENCY_DECIMALS)) {
      expect(toSmallestUnits(fromSmallestUnits(987_654_321n, currency), currency)).toBe(987_654_321n);
    }
  });
});

describe('Decimal128 bridge', () => {
  it('round-trips BigInt through Decimal128', () => {
    expect(decimal128ToBigInt(bigIntToDecimal128(987654321n))).toBe(987654321n);
    expect(decimal128ToBigInt(bigIntToDecimal128(0n))).toBe(0n);
  });

  it('treats null/undefined as zero (fresh wallets)', () => {
    expect(decimal128ToBigInt(null)).toBe(0n);
    expect(decimal128ToBigInt(undefined)).toBe(0n);
  });
});

describe('arithmetic helpers', () => {
  it('addAmounts sums BigInts', () => {
    expect(addAmounts(1n, 2n, 3n)).toBe(6n);
  });

  it('subtractAmounts refuses to go negative (balances never below zero)', () => {
    expect(subtractAmounts(10n, 4n)).toBe(6n);
    expect(() => subtractAmounts(4n, 10n)).toThrow(RangeError);
  });

  it('percentOf floors to smallest units and accepts fractional percents', () => {
    expect(percentOf(100000n, 10)).toBe(10000n); // L1 10%
    expect(percentOf(100000n, '2.5')).toBe(2500n);
    expect(percentOf(3n, 10)).toBe(0n); // floor, never rounds up
    expect(() => percentOf(100n, '-5')).toThrow(RangeError);
  });
});
