// Import-and-invariant smoke test: verifies every model registers and the core
// utils behave, without needing a running MongoDB. Run with `npm run smoke`.
import assert from 'node:assert/strict';
import * as models from '../src/models/index.js';
import {
  toSmallestUnits,
  fromSmallestUnits,
  bigIntToDecimal128,
  decimal128ToBigInt,
  percentOf,
  subtractAmounts,
} from '../src/utils/money.js';
import { parsePhone } from '../src/utils/phone.js';
import { hashValue, compareValue, normalizeSecurityAnswer } from '../src/utils/hash.js';
import { generateReferralCode } from '../src/utils/referralCode.js';
import { lagosParts, lagosDayKey, isWithinSignalWindow } from '../src/utils/time.js';
import { randomToken, sha256 } from '../src/utils/tokens.js';

const expectedModels = [
  'User', 'Wallet', 'LedgerEntry', 'Deposit', 'Withdrawal', 'Trade', 'Signal',
  'SignalPosition', 'Referral', 'Notification', 'Announcement',
  'AuditLog', 'Captcha', 'Session',
];
for (const name of expectedModels) {
  assert.ok(models[name]?.modelName === name, `model ${name} registered`);
}

// money: NGN kobo round-trip, no floats
assert.equal(toSmallestUnits('1234.56', 'NGN'), 123456n);
assert.equal(fromSmallestUnits(123456n, 'NGN'), '1234.56');
assert.equal(toSmallestUnits('0.00000001', 'BTC'), 1n); // 1 satoshi
assert.equal(fromSmallestUnits(10n ** 18n, 'ETH'), '1');
assert.equal(decimal128ToBigInt(bigIntToDecimal128(987654321n)), 987654321n);
assert.equal(percentOf(100000n, 10), 10000n); // L1 10% of ₦1000 (kobo)
assert.equal(percentOf(100000n, '2.5'), 2500n);
assert.throws(() => toSmallestUnits('1.234', 'NGN')); // 3dp kobo rejected
assert.throws(() => subtractAmounts(5n, 10n)); // negative balances rejected

// phone: E.164 canonicalization
const phone = parsePhone('08012345678', 'NG');
assert.deepEqual(phone, { countryCode: '+234', nationalNumber: '8012345678', e164: '+2348012345678' });
assert.throws(() => parsePhone('12345'));

// hashing: bcryptjs round-trip + security-answer normalization
const hash = await hashValue('s3cret!');
assert.equal(await compareValue('s3cret!', hash), true);
assert.equal(await compareValue('wrong', hash), false);
assert.equal(normalizeSecurityAnswer('  My  First DOG '), 'my first dog');

// referral code: 8 chars from the unambiguous alphabet
assert.match(generateReferralCode(), /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);

// time: Lagos window math (fixed instants — Lagos is UTC+1, no DST)
assert.equal(isWithinSignalWindow(new Date('2026-07-05T14:30:00Z')), true); // 15:30 WAT
assert.equal(isWithinSignalWindow(new Date('2026-07-05T16:00:00Z')), false); // 17:00 WAT
assert.equal(lagosDayKey(new Date('2026-07-05T23:30:00Z')), '2026-07-06'); // past midnight WAT
assert.equal(typeof lagosParts().hour, 'number');

// tokens
assert.equal(randomToken(16).length, 32);
assert.equal(sha256('a'), sha256('a'));
assert.notEqual(sha256('a'), sha256('b'));

console.log(`Smoke test passed: ${expectedModels.length} models registered, utils behave as specified.`);
process.exit(0);
