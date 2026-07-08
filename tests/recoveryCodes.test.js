import { describe, it, expect } from 'vitest';
import {
  generateRecoveryCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  hashRecoveryCode,
  RECOVERY_CODE_COUNT,
} from '../src/utils/recoveryCodes.js';

describe('generateRecoveryCode', () => {
  it('is grouped, unambiguous-alphabet, and unique per call', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      const code = generateRecoveryCode();
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(50); // no collisions across 50 draws
  });
});

describe('normalizeRecoveryCode', () => {
  it('strips spaces/dashes and uppercases so display format never blocks a match', () => {
    expect(normalizeRecoveryCode('a3f9k-2m7qx')).toBe('A3F9K2M7QX');
    expect(normalizeRecoveryCode('  A3F9K 2M7QX ')).toBe('A3F9K2M7QX');
  });

  it('hashRecoveryCode is format-insensitive but value-sensitive', () => {
    expect(hashRecoveryCode('a3f9k-2m7qx')).toBe(hashRecoveryCode('A3F9K2M7QX'));
    expect(hashRecoveryCode('A3F9K-2M7QX')).not.toBe(hashRecoveryCode('A3F9K-2M7QY'));
    expect(hashRecoveryCode('x')).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });
});

describe('generateRecoveryCodes', () => {
  it('returns the default count with plaintext + matching hashed/unused entries', () => {
    const { plain, stored } = generateRecoveryCodes();
    expect(plain).toHaveLength(RECOVERY_CODE_COUNT);
    expect(stored).toHaveLength(RECOVERY_CODE_COUNT);
    stored.forEach((entry, i) => {
      expect(entry.usedAt).toBeNull();
      expect(entry.codeHash).toBe(hashRecoveryCode(plain[i]));
    });
  });

  it('never stores plaintext (only hashes)', () => {
    const { plain, stored } = generateRecoveryCodes();
    for (const entry of stored) expect(plain).not.toContain(entry.codeHash);
  });
});
