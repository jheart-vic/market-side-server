import { describe, it, expect } from 'vitest';
import { generateReferralCode } from '../src/utils/referralCode.js';

describe('generateReferralCode', () => {
  it('is 8 chars from the unambiguous alphabet (no 0/O/1/I/L)', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateReferralCode()).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    }
  });
});
