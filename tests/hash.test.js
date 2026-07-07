import { describe, it, expect } from 'vitest';
import { hashValue, compareValue, normalizeSecurityAnswer } from '../src/utils/hash.js';

describe('bcrypt wrappers', () => {
  it('round-trips a value and rejects the wrong one', async () => {
    const hash = await hashValue('s3cret!');
    expect(await compareValue('s3cret!', hash)).toBe(true);
    expect(await compareValue('wrong', hash)).toBe(false);
  });

  it('compareValue against a missing hash is false, not a crash', async () => {
    expect(await compareValue('anything', null)).toBe(false);
    expect(await compareValue('anything', undefined)).toBe(false);
  });
});

describe('normalizeSecurityAnswer', () => {
  it('lowercases, trims, and collapses whitespace so users are not locked out', () => {
    expect(normalizeSecurityAnswer('  My  First DOG ')).toBe('my first dog');
    expect(normalizeSecurityAnswer('Bingo\tTHE\n dog')).toBe('bingo the dog');
    expect(normalizeSecurityAnswer(null)).toBe('');
  });

  it('normalized variants hash-compare equal', async () => {
    const hash = await hashValue(normalizeSecurityAnswer('Bingo THE Dog'));
    expect(await compareValue(normalizeSecurityAnswer(' bingo the dog '), hash)).toBe(true);
  });
});
