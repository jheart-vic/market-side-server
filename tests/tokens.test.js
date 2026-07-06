import { describe, it, expect } from 'vitest';
import { randomToken, sha256 } from '../src/utils/tokens.js';

describe('tokens', () => {
  it('randomToken returns hex of the requested byte length', () => {
    expect(randomToken(16)).toHaveLength(32);
    expect(randomToken(48)).toHaveLength(96);
    expect(randomToken(16)).not.toBe(randomToken(16));
  });

  it('sha256 is deterministic and collision-visible', () => {
    expect(sha256('a')).toBe(sha256('a'));
    expect(sha256('a')).not.toBe(sha256('b'));
    expect(sha256('a')).toMatch(/^[0-9a-f]{64}$/);
  });
});
