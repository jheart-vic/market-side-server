import { describe, it, expect } from 'vitest';
import { parsePhone } from '../src/utils/phone.js';

describe('parsePhone (E.164 canonicalization)', () => {
  it('parses Nigerian local format', () => {
    expect(parsePhone('08012345678', 'NG')).toEqual({
      countryCode: '+234',
      nationalNumber: '8012345678',
      e164: '+2348012345678',
    });
  });

  it('parses already-international input', () => {
    expect(parsePhone('+2348012345678').e164).toBe('+2348012345678');
  });

  it('rejects invalid numbers', () => {
    expect(() => parsePhone('12345')).toThrow();
    expect(() => parsePhone('not a phone')).toThrow();
    expect(() => parsePhone('')).toThrow();
  });
});
