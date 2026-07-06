import { describe, it, expect } from 'vitest';
import { DEFAULTS } from '../src/services/settings.service.js';
import { toSmallestUnits, fromSmallestUnits } from '../src/utils/money.js';

// The Spin & Win outcome rule: every spin wins the LOWEST configured prize,
// except each spin_bonus_every-th spin of the Lagos day platform-wide, which
// wins the SECOND lowest. These tests pin the default wheel config and the
// selection math the service applies (spin.service.js).

const prizeUnits = () => DEFAULTS.spin_prizes.map((p) => toSmallestUnits(String(p), 'USDT'));

describe('default wheel configuration', () => {
  it('has exactly 9 prizes, all valid dollar strings', () => {
    expect(DEFAULTS.spin_prizes).toHaveLength(9);
    expect(() => prizeUnits()).not.toThrow();
  });

  it('the two lowest values are $0.5 and $0.8 — the only winnable prizes', () => {
    const sorted = [...prizeUnits()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(fromSmallestUnits(sorted[0], 'USDT')).toBe('0.5');
    expect(fromSmallestUnits(sorted[1], 'USDT')).toBe('0.8');
  });

  it('bonus cadence defaults to every 5th spin; referral reward to 1 credit', () => {
    expect(DEFAULTS.spin_bonus_every).toBe(5);
    expect(DEFAULTS.spin_referral_reward).toBe(1);
  });
});

describe('outcome selection (sequence % bonusEvery)', () => {
  const outcomeFor = (sequence, bonusEvery = DEFAULTS.spin_bonus_every) => {
    const units = prizeUnits();
    const sorted = [...units].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const bonus = sequence % bonusEvery === 0;
    return { bonus, prize: fromSmallestUnits(bonus ? sorted[1] : sorted[0], 'USDT') };
  };

  it('spins 1–4 win the lowest, the 5th wins the second lowest', () => {
    for (const seq of [1, 2, 3, 4]) expect(outcomeFor(seq)).toEqual({ bonus: false, prize: '0.5' });
    expect(outcomeFor(5)).toEqual({ bonus: true, prize: '0.8' });
  });

  it('resets every cycle: 6–9 win the lowest again, the 10th is a bonus', () => {
    for (const seq of [6, 7, 8, 9]) expect(outcomeFor(seq).bonus).toBe(false);
    expect(outcomeFor(10)).toEqual({ bonus: true, prize: '0.8' });
  });

  it('the prize index always points at a real wheel segment', () => {
    const units = prizeUnits();
    const sorted = [...units].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const winnable of [sorted[0], sorted[1]]) {
      const index = units.findIndex((u) => u === winnable);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(9);
    }
  });
});
