import { describe, it, expect } from 'vitest';
import { lagosParts, lagosDayKey, lagosWeekday, isWithinSignalWindow } from '../src/utils/time.js';

// Lagos is UTC+1 with no DST, so fixed UTC instants map deterministically.

describe('lagosParts / lagosDayKey', () => {
  it('shifts UTC instants to Lagos wall clock', () => {
    const parts = lagosParts(new Date('2026-07-05T14:30:00Z'));
    expect(parts.hour).toBe(15);
    expect(parts.minute).toBe(30);
    expect(parts.day).toBe(5);
  });

  it('rolls the day key past Lagos midnight', () => {
    expect(lagosDayKey(new Date('2026-07-05T23:30:00Z'))).toBe('2026-07-06');
    expect(lagosDayKey(new Date('2026-07-05T22:30:00Z'))).toBe('2026-07-05');
  });
});

describe('lagosWeekday', () => {
  it('maps to 0=Sunday…6=Saturday in Lagos time', () => {
    // 2026-07-05 is a Sunday; 23:30Z is already Monday 00:30 in Lagos
    expect(lagosWeekday(new Date('2026-07-05T12:00:00Z'))).toBe(0);
    expect(lagosWeekday(new Date('2026-07-05T23:30:00Z'))).toBe(1);
  });
});

describe('isWithinSignalWindow (3–5 pm Lagos, [start, end))', () => {
  it('accepts inside the window', () => {
    expect(isWithinSignalWindow(new Date('2026-07-05T14:00:00Z'))).toBe(true); // 15:00 WAT
    expect(isWithinSignalWindow(new Date('2026-07-05T15:59:00Z'))).toBe(true); // 16:59 WAT
  });

  it('rejects the boundaries and outside', () => {
    expect(isWithinSignalWindow(new Date('2026-07-05T13:59:00Z'))).toBe(false); // 14:59 WAT
    expect(isWithinSignalWindow(new Date('2026-07-05T16:00:00Z'))).toBe(false); // 17:00 WAT — end is exclusive
  });
});
