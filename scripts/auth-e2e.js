// Live end-to-end test of the auth chain against the configured MongoDB (.env).
// Creates a throwaway user, exercises every auth flow, then deletes everything
// it made. Run with `npm run test:auth`.
import assert from 'node:assert/strict';
import { generate as totpGenerate } from 'otplib';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { Captcha } from '../src/models/Captcha.js';
import { User } from '../src/models/User.js';
import { Wallet } from '../src/models/Wallet.js';
import { Session } from '../src/models/Session.js';
import { Notification } from '../src/models/Notification.js';
import { sha256 } from '../src/utils/tokens.js';
import * as auth from '../src/services/auth.service.js';

// Test captchas are seeded directly (answers are hashed in the DB, so the real
// service never reveals them; this simulates a user who answered correctly).
async function seedCaptcha(purpose, answer = 'abc12') {
  const c = await Captcha.create({
    answerHash: sha256(answer),
    purpose,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { captchaId: c.id, captchaAnswer: answer };
}

const stamp = Date.now().toString().slice(-9);
const testPhone = `+23480${stamp.slice(0, 8)}`;
const testEmail = `e2e-${stamp}@test.local`;
const meta = { ip: '127.0.0.1', userAgent: 'e2e-test' };
let userId;

try {
  await connectDb();

  // --- register ---
  const reg = await auth.register({
    phone: testPhone,
    email: testEmail,
    username: `e2e_${stamp}`,
    fullName: 'E2E Test User',
    password: 'Passw0rd!x',
    securityQuestionId: 'first-pet-name',
    securityAnswer: '  Bingo THE dog ',
    ...(await seedCaptcha('register')),
    meta,
  });
  userId = reg.user.id;
  assert.ok(reg.accessToken && reg.refreshToken, 'register returns tokens');
  assert.equal(reg.user.email, testEmail);
  assert.match(reg.user.referralCode, /^[2-9A-Z]{8}$/);
  const wallets = await Wallet.find({ user: userId });
  assert.equal(wallets.length, 5, '5 wallets created');
  console.log('✓ register (user + 5 wallets + session)');

  // --- wrong captcha answer rejected ---
  const badCap = await seedCaptcha('login');
  await assert.rejects(
    auth.login({ identifier: testEmail, password: 'Passw0rd!x', captchaId: badCap.captchaId, captchaAnswer: 'WRONG', meta }),
    /Captcha/i,
  );
  console.log('✓ wrong captcha rejected');

  // --- login (new device triggers login alert notification) ---
  const login1 = await auth.login({
    identifier: testEmail,
    password: 'Passw0rd!x',
    ...(await seedCaptcha('login')),
    meta: { ip: '10.0.0.9', userAgent: 'other-device' },
  });
  assert.ok(login1.accessToken, 'login returns tokens');
  const alerts = await Notification.find({ user: userId, type: 'login_alert' });
  assert.equal(alerts.length, 1, 'login alert recorded for new device');
  console.log('✓ login + new-device alert');

  // --- login by phone, wrong password rejected ---
  await assert.rejects(
    auth.login({ identifier: testPhone, password: 'nope', ...(await seedCaptcha('login')), meta }),
    /Invalid credentials/,
  );
  console.log('✓ wrong password rejected');

  // --- unknown identifier: same error as wrong password (timing-decoy path, no enumeration) ---
  await assert.rejects(
    auth.login({ identifier: 'nobody@nowhere.test', password: 'nope', ...(await seedCaptcha('login')), meta }),
    /Invalid credentials/,
  );
  console.log('✓ unknown user rejected identically (decoy compare, no ReferenceError)');

  // --- login by username ---
  const byUsername = await auth.login({
    identifier: `E2E_${stamp}`, // case-insensitive
    password: 'Passw0rd!x',
    ...(await seedCaptcha('login')),
    meta: { ip: '10.0.0.9', userAgent: 'other-device' },
  });
  assert.equal(byUsername.user.username, `e2e_${stamp}`);
  console.log('✓ login by username');

  // --- refresh rotation + replay detection ---
  const r1 = await auth.refresh(login1.refreshToken, meta);
  assert.ok(r1.refreshToken !== login1.refreshToken, 'rotation issues a new token');
  await assert.rejects(auth.refresh(login1.refreshToken, meta), /Invalid refresh/); // replay of rotated token
  await assert.rejects(auth.refresh(r1.refreshToken, meta), /Invalid refresh/); // session was revoked by replay
  console.log('✓ refresh rotation + replay revokes session');

  // --- security question + password reset ---
  const q = await auth.getSecurityQuestion(testEmail);
  assert.equal(q.question, 'What was the name of your first pet?');
  await assert.rejects(
    auth.resetPassword({ identifier: testEmail, answer: 'wrong answer', newPassword: 'NewPass1!', ...(await seedCaptcha('password_reset')) }),
    /Password reset failed/,
  );
  await auth.resetPassword({
    identifier: testEmail,
    answer: 'bingo the  DOG', // normalization: case/spacing insensitive
    newPassword: 'NewPass1!',
    ...(await seedCaptcha('password_reset')),
  });
  const login2 = await auth.login({ identifier: testEmail, password: 'NewPass1!', ...(await seedCaptcha('login')), meta });
  assert.ok(login2.accessToken, 'login works with reset password');
  console.log('✓ security-question reset (normalized answer)');

  // --- withdrawal PIN (no 2FA yet → password path) ---
  const userDoc = await User.findById(userId);
  await assert.rejects(auth.setWithdrawalPin(userDoc, { pin: '12', password: 'NewPass1!' }), /4–6 digits/);
  await auth.setWithdrawalPin(userDoc, { pin: '4321', password: 'NewPass1!' });
  await auth.verifyWithdrawalPin(userDoc, '4321');
  await assert.rejects(auth.verifyWithdrawalPin(userDoc, '9999'), /Incorrect/);
  console.log('✓ withdrawal PIN set/verify (password-guarded)');

  // --- 2FA enable/confirm, TOTP login, PIN now TOTP-guarded, disable ---
  const setup = await auth.enable2fa(userDoc);
  assert.match(setup.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.match(setup.qr, /^data:image\/png/);
  await assert.rejects(auth.confirm2fa(userDoc, '000000'), /Invalid authenticator/);
  await auth.confirm2fa(userDoc, await totpGenerate({ secret: setup.secret }));

  const step1 = await auth.login({ identifier: testEmail, password: 'NewPass1!', ...(await seedCaptcha('login')), meta });
  assert.deepEqual(step1, { requiresTotp: true }, 'password-only login asks for TOTP');
  const login3 = await auth.login({
    identifier: testEmail,
    password: 'NewPass1!',
    totp: await totpGenerate({ secret: setup.secret }),
    ...(await seedCaptcha('login')),
    meta,
  });
  assert.ok(login3.accessToken && login3.user.twoFactorEnabled, '2FA login works');

  await assert.rejects(auth.setWithdrawalPin(userDoc, { pin: '5555', password: 'NewPass1!' }), /authenticator/);
  await auth.setWithdrawalPin(userDoc, { pin: '5555', totp: await totpGenerate({ secret: setup.secret }) });
  await auth.verifyWithdrawalPin(userDoc, '5555');
  await auth.disable2fa(userDoc, await totpGenerate({ secret: setup.secret }));
  console.log('✓ 2FA enable/confirm/login/disable + TOTP-guarded PIN change');

  // --- logout revokes the session ---
  await auth.logout(login3.refreshToken);
  await assert.rejects(auth.refresh(login3.refreshToken, meta), /Invalid refresh/);
  console.log('✓ logout revokes session');

  console.log('\nALL AUTH E2E CHECKS PASSED');
} finally {
  if (userId) {
    await Promise.all([
      User.deleteOne({ _id: userId }),
      Wallet.deleteMany({ user: userId }),
      Session.deleteMany({ user: userId }),
      Notification.deleteMany({ user: userId }),
    ]);
    console.log('(test data cleaned up)');
  }
  await disconnectDb();
}
