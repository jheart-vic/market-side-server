// HTTP end-to-end test: boots the real Express app on an ephemeral port and
// drives the auth + wallet routes over fetch — cookies, CSRF, validation and
// all. Test data is deleted afterwards. Run with `npm run test:http`.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { initSocket } from '../src/socket/index.js';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { Captcha } from '../src/models/Captcha.js';
import { User } from '../src/models/User.js';
import { Wallet } from '../src/models/Wallet.js';
import { Session } from '../src/models/Session.js';
import { Notification } from '../src/models/Notification.js';
import { LedgerEntry } from '../src/models/LedgerEntry.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { Spin } from '../src/models/Spin.js';
import { BankAccount } from '../src/models/BankAccount.js';
import { sha256 } from '../src/utils/tokens.js';
import { toSmallestUnits, fromSmallestUnits } from '../src/utils/money.js';

async function seedCaptcha(purpose, answer = 'abc12') {
  const c = await Captcha.create({
    answerHash: sha256(answer),
    purpose,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { captchaId: c.id, captchaAnswer: answer };
}

// Minimal cookie jar
const jar = new Map();
function storeCookies(res) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const [name, ...v] = pair.split('=');
    const value = v.join('=');
    if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name.trim());
    else jar.set(name.trim(), value);
  }
}
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

let base;
async function api(path, { method = 'GET', body, csrf = false } = {}) {
  const headers = { 'content-type': 'application/json', cookie: cookieHeader() };
  if (csrf && jar.has('ms_csrf')) headers['x-csrf-token'] = jar.get('ms_csrf');
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  storeCookies(res);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const stamp = Date.now().toString().slice(-9);
const testEmail = `http-${stamp}@test.local`;
let userId;
let target; // impersonation target, created directly in the DB
let server;
let socketGateway;

try {
  await connectDb();
  server = app.listen(0);
  socketGateway = initSocket(server);
  base = `http://127.0.0.1:${server.address().port}`;

  // health
  const health = await api('/api/health');
  assert.equal(health.status, 200);
  console.log('✓ GET /api/health');

  // admin login (env-configured superadmin, no captcha). Run before the user
  // session exists so nothing clobbers cookies; use a raw fetch when configured
  // so the admin session isn't stored in the shared jar.
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && process.env.ADMIN_PHONE) {
    const r = await fetch(`${base}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
    });
    const body = JSON.parse(await r.text());
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.ok(['admin', 'superadmin'].includes(body.user.role), 'admin role');
    assert.ok(r.headers.getSetCookie().some((c) => c.startsWith('ms_access=')), 'admin login sets access cookie');
    // wrong password → 401 (same error as wrong email)
    const bad = await fetch(`${base}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: 'definitely-wrong' }),
    });
    assert.equal(bad.status, 401);
    console.log('✓ POST /api/auth/admin/login (env superadmin) → 200 + cookie, wrong password → 401');
  } else {
    const unconfigured = await api('/api/auth/admin/login', {
      method: 'POST',
      body: { email: 'admin@example.test', password: 'whatever-123' },
    });
    assert.equal(unconfigured.status, 503);
    assert.equal(unconfigured.body.code, 'ADMIN_NOT_CONFIGURED');
    console.log('✓ POST /api/auth/admin/login unconfigured → 503 ADMIN_NOT_CONFIGURED');
  }

  // captcha challenge issue (real one — just checking the shape)
  const cap = await api('/api/auth/captcha?purpose=register');
  assert.equal(cap.status, 200);
  assert.ok(cap.body.captchaId && cap.body.svg.startsWith('<svg'), 'captcha returns id + svg');
  console.log('✓ GET /api/auth/captcha (id + svg)');

  // validation errors surface as 400 VALIDATION_ERROR
  const bad = await api('/api/auth/register', { method: 'POST', body: { email: 'not-an-email' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'VALIDATION_ERROR');
  console.log('✓ zod validation → 400 VALIDATION_ERROR');

  // register (seeded captcha) → 201 + auth cookies set
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      phone: '080' + stamp.slice(1),
      email: testEmail,
      username: `http_${stamp}`,
      fullName: 'HTTP E2E User',
      password: 'Passw0rd!x',
      ...(await seedCaptcha('register')),
    },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  userId = reg.body.user.id;
  assert.ok(Array.isArray(reg.body.recoveryCodes) && reg.body.recoveryCodes.length === 10, 'register returns 10 recovery codes');
  console.log('✓ register returns one-time recovery codes');

  assert.ok(jar.has('ms_access') && jar.has('ms_refresh') && jar.has('ms_csrf'), 'auth cookies set');
  console.log('✓ POST /api/auth/register → 201 + ms_access/ms_refresh/ms_csrf cookies');

  // authenticated request via cookie
  const me = await api('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, testEmail);
  console.log('✓ GET /api/auth/me (cookie auth)');

  // CSRF: mutating request with cookies but no header → 403
  const noCsrf = await api('/api/auth/refresh', { method: 'POST' });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.code, 'CSRF_FAILED');
  console.log('✓ POST without x-csrf-token → 403 CSRF_FAILED');

  // with the CSRF header it rotates fine
  const refreshed = await api('/api/auth/refresh', { method: 'POST', csrf: true });
  assert.equal(refreshed.status, 200);
  console.log('✓ POST /api/auth/refresh (CSRF header) → rotated cookies');

  // wallets
  const wallets = await api('/api/wallets');
  assert.equal(wallets.status, 200);
  assert.equal(wallets.body.wallets.length, 5);
  const ngn = await api('/api/wallets/NGN');
  assert.equal(ngn.body.wallet.balance, '0');
  const badCur = await api('/api/wallets/DOGE');
  assert.equal(badCur.status, 400);
  console.log('✓ GET /api/wallets + /api/wallets/NGN (DOGE → 400)');

  // --- sessions & devices ---
  // a second login opens a second session (jar now holds the newest = current)
  await api('/api/auth/login', {
    method: 'POST',
    csrf: true,
    body: { identifier: testEmail, password: 'Passw0rd!x', ...(await seedCaptcha('login')) },
  });
  let sess = (await api('/api/sessions')).body.sessions;
  assert.ok(sess.length >= 2, 'two active sessions');
  assert.equal(sess.filter((s) => s.current).length, 1, 'exactly one current session');
  assert.ok('browser' in sess[0].device && 'os' in sess[0].device, 'session carries a parsed device label');
  // delete a non-current session by id ("log out that device")
  const other = sess.find((s) => !s.current);
  const delSession = await api(`/api/sessions/${other.id}`, { method: 'DELETE', csrf: true });
  assert.equal(delSession.status, 200);
  assert.equal(delSession.body.wasCurrent, false);
  // open another, then revoke-others keeps only the current session alive
  await api('/api/auth/login', {
    method: 'POST',
    csrf: true,
    body: { identifier: testEmail, password: 'Passw0rd!x', ...(await seedCaptcha('login')) },
  });
  const revoked = await api('/api/sessions/revoke-others', { method: 'POST', csrf: true });
  assert.ok(revoked.body.revokedCount >= 1, 'other sessions revoked');
  sess = (await api('/api/sessions')).body.sessions;
  assert.equal(sess.length, 1, 'only the current session remains');
  assert.ok(sess[0].current);
  console.log('✓ sessions: list (device + current), delete by id, revoke-others keeps current');

  // profile + user-facing feature routes
  const profile = await api('/api/users/me');
  assert.equal(profile.status, 200);
  assert.equal(profile.body.profile.username, `http_${stamp}`);
  assert.equal(profile.body.profile.fullName, 'HTTP E2E User');
  const tx = await api('/api/transactions?currency=NGN');
  assert.equal(tx.status, 200);
  assert.ok(Array.isArray(tx.body.items), 'transactions list shape');
  const notif = await api('/api/notifications');
  assert.equal(notif.status, 200);
  assert.ok(typeof notif.body.unreadCount === 'number');
  const refStats = await api('/api/referrals/stats');
  assert.equal(refStats.status, 200);
  assert.equal(refStats.body.stats.totalReferrals, 0);
  const refQr = await api('/api/referrals/qr');
  assert.ok(refQr.body.qr.startsWith('data:image/png;base64,'), 'referral QR data-URL');
  const ann = await api('/api/announcements');
  assert.equal(ann.status, 200);
  const trades = await api('/api/trades');
  assert.equal(trades.status, 200);
  assert.deepEqual(trades.body.items, []);
  const activeSignals = await api('/api/signals/active');
  assert.equal(activeSignals.status, 200);
  assert.ok(Array.isArray(activeSignals.body.signals));
  console.log('✓ GET /users/me, /transactions, /notifications, /referrals, /announcements, /trades, /signals/active');

  // Socket.IO gateway: Engine.IO polling handshake answers on the same port
  const eio = await fetch(`${base}/socket.io/?EIO=4&transport=polling`);
  assert.equal(eio.status, 200);
  const eioBody = await eio.text();
  assert.ok(eioBody.startsWith('0{'), 'engine.io open packet');
  assert.ok(eioBody.includes('"sid"'), 'handshake carries a session id');
  console.log('✓ Socket.IO gateway handshake on the same HTTP server');

  // admin routes are role-gated: plain user → 403
  const adminDenied = await api('/api/admin/users');
  assert.equal(adminDenied.status, 403);
  assert.equal(adminDenied.body.code, 'FORBIDDEN_ROLE');
  console.log('✓ GET /api/admin/users as plain user → 403 FORBIDDEN_ROLE');

  // --- admin suite: promote the test user (requireAuth reloads the user doc
  // per request, so a DB role change takes effect without re-login) ---
  await User.updateOne({ _id: userId }, { $set: { role: 'admin' } });
  const adminUsers = await api('/api/admin/users');
  assert.equal(adminUsers.status, 200);
  assert.ok(Array.isArray(adminUsers.body.items));
  console.log('✓ promoted to admin → GET /api/admin/users 200');

  // reports: overview cards + a time series
  const overview = await api('/api/admin/reports/overview');
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
  assert.ok(overview.body.report.users.total >= 1);
  for (const key of ['deposits', 'withdrawals', 'trades', 'signals', 'referrals']) {
    assert.ok(overview.body.report[key], `report has ${key} section`);
  }
  const series = await api('/api/admin/reports/timeseries?metric=trades');
  assert.equal(series.status, 200);
  assert.ok(Array.isArray(series.body.points));
  const badMetric = await api('/api/admin/reports/timeseries?metric=nope');
  assert.equal(badMetric.status, 400);
  console.log('✓ GET /api/admin/reports/overview + timeseries (bad metric → 400)');

  // wallet adjustment → audited ledger credit with before/after balances
  const credit = await api(`/api/admin/users/${userId}/wallet`, {
    method: 'POST',
    csrf: true,
    body: { currency: 'USDT', direction: 'credit', amount: '5', reason: 'http e2e credit' },
  });
  assert.equal(credit.status, 201, JSON.stringify(credit.body));
  assert.equal(credit.body.balanceBefore, '0');
  assert.equal(credit.body.balanceAfter, '5');
  const usdtWallet = await api('/api/wallets/USDT');
  assert.equal(usdtWallet.body.wallet.balance, '5');
  console.log('✓ POST /api/admin/users/:id/wallet credit → ledger entry + before/after balances');

  // Spin & Win: admin grants credits → wheel shows them → spin pays via ledger
  const grant = await api(`/api/admin/users/${userId}/spins`, {
    method: 'POST',
    csrf: true,
    body: { count: 2, reason: 'http e2e spins' },
  });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));
  assert.equal(grant.body.spinCredits, 2);

  const wheel = await api('/api/spin');
  assert.equal(wheel.status, 200);
  assert.equal(wheel.body.wheel.prizes.length, 9);
  assert.equal(wheel.body.wheel.credits, 2);

  const spun = await api('/api/spin', { method: 'POST', csrf: true });
  assert.equal(spun.status, 200, JSON.stringify(spun.body));
  // outcome is always one of the two lowest configured prizes
  assert.ok(['0.5', '0.8'].includes(spun.body.prizeUsd), `won ${spun.body.prizeUsd}`);
  assert.equal(spun.body.creditsLeft, 1);
  assert.ok(spun.body.prizeIndex >= 0 && spun.body.prizeIndex < 9, 'segment index for the wheel');

  const expectedBalance = fromSmallestUnits(
    toSmallestUnits('5', 'USDT') + toSmallestUnits(spun.body.prizeUsd, 'USDT'),
    'USDT',
  );
  const walletAfterSpin = await api('/api/wallets/USDT');
  assert.equal(walletAfterSpin.body.wallet.balance, expectedBalance, 'prize paid via ledger');

  const spinHistory = await api('/api/spin/history');
  assert.equal(spinHistory.body.items.length, 1);
  const adminSpins = await api('/api/admin/spins');
  assert.ok(adminSpins.body.items.some((s) => s.id === spun.body.spinId), 'admin feed shows the spin');
  console.log('✓ spin & win: grant 2 → wheel → spin pays lowest-tier prize via ledger → history + admin feed');

  // Bank accounts: list banks, bind two (newest = default), switch default, delete
  const bankList = await api('/api/bank/list');
  assert.equal(bankList.status, 200);
  assert.ok(bankList.body.banks.length > 10 && bankList.body.banks[0].code && bankList.body.banks[0].name);

  const code1 = 'GUARANTY TRUST BANK PLC'; // from config/ngBanks.js
  const code2 = 'UNITED BANK FOR AFRICA PLC';
  const bind1 = await api('/api/bank/bind', {
    method: 'POST',
    csrf: true,
    body: { bankCode: code1, accountName: 'HTTP E2E User', accountNumber: '0123456789' },
  });
  assert.equal(bind1.status, 201, JSON.stringify(bind1.body));
  assert.equal(bind1.body.account.isDefault, true);
  assert.equal(bind1.body.account.bankName, 'GTBank'); // display name derived from ngBanks

  const bind2 = await api('/api/bank/bind', {
    method: 'POST',
    csrf: true,
    body: { bankCode: code2, accountName: 'HTTP E2E User', accountNumber: '2109876543' },
  });
  assert.equal(bind2.status, 201);
  assert.equal(bind2.body.account.isDefault, true); // newest becomes default

  // unsupported bank rejected at validation
  const badBank = await api('/api/bank/bind', {
    method: 'POST',
    csrf: true,
    body: { bankCode: 'NOT A REAL BANK', accountName: 'x y', accountNumber: '0123456789' },
  });
  assert.equal(badBank.status, 400);

  // duplicate (same user+bank+number) → 409
  const dup = await api('/api/bank/bind', {
    method: 'POST',
    csrf: true,
    body: { bankCode: code2, accountName: 'HTTP E2E User', accountNumber: '2109876543' },
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'BANK_ACCOUNT_EXISTS');

  const accounts = await api('/api/bank/accounts');
  assert.equal(accounts.body.accounts.length, 2);
  assert.equal(accounts.body.accounts[0].isDefault, true); // default sorts first
  const firstId = bind1.body.account.id;

  // switch the default back to the first account
  const setDef = await api(`/api/bank/accounts/${firstId}/default`, { method: 'POST', csrf: true });
  assert.equal(setDef.status, 200);
  assert.equal(setDef.body.account.isDefault, true);

  // delete the current default → the other is promoted
  const del = await api(`/api/bank/accounts/${firstId}`, { method: 'DELETE', csrf: true });
  assert.equal(del.status, 200);
  const afterDel = await api('/api/bank/accounts');
  assert.equal(afterDel.body.accounts.length, 1);
  assert.equal(afterDel.body.accounts[0].isDefault, true); // promoted
  console.log('✓ bank accounts: list → bind ×2 (newest default) → dup 409 → switch default → delete promotes');

  // impersonation: browse AS the target, admin routes blocked, exit restores
  target = await User.create({
    phone: { countryCode: '+234', nationalNumber: '70' + stamp.slice(1), e164: `+23470${stamp.slice(1)}` },
    email: `imp-${stamp}@test.local`,
    passwordHash: 'not-a-real-hash',
    security: { question: 'q?', answerHash: 'not-a-real-hash' },
    referralCode: `IMP${stamp.slice(-5)}`,
  });
  const imp = await api(`/api/admin/users/${target.id}/impersonate`, {
    method: 'POST',
    csrf: true,
    body: { reason: 'support e2e' },
  });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.impersonating, true);
  assert.equal(imp.body.user.id, target.id);

  const meImp = await api('/api/auth/me');
  assert.equal(meImp.body.user.id, target.id, 'authenticated as the target now');
  assert.equal(meImp.body.impersonation.adminId, userId);

  const blocked = await api('/api/admin/users');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'IMPERSONATION_ACTIVE');

  const exitImp = await api('/api/admin/impersonation/exit', { method: 'POST', csrf: true });
  assert.equal(exitImp.status, 200, JSON.stringify(exitImp.body));
  const meBack = await api('/api/auth/me');
  assert.equal(meBack.body.user.id, userId, 'admin session restored');
  assert.equal(meBack.body.impersonation, null);
  console.log('✓ impersonate → me is target, admin routes 403 → exit → admin restored');

  // logout clears cookies; me becomes 401
  const out = await api('/api/auth/logout', { method: 'POST', csrf: true });
  assert.equal(out.status, 204);
  const meAfter = await api('/api/auth/me');
  assert.equal(meAfter.status, 401);
  console.log('✓ POST /api/auth/logout → 204, cookies cleared, /me → 401');

  console.log('\nALL HTTP E2E CHECKS PASSED');
} finally {
  if (userId) {
    const uid = new mongoose.Types.ObjectId(userId);
    await Promise.all([
      User.deleteOne({ _id: userId }),
      Wallet.deleteMany({ user: userId }),
      Session.deleteMany({ user: userId }),
      Notification.deleteMany({ user: userId }),
      Spin.deleteMany({ user: userId }),
      BankAccount.deleteMany({ user: userId }),
      // append-only collections: raw driver deleteMany bypasses the immutability hooks
      LedgerEntry.collection.deleteMany({ user: uid }),
      AuditLog.collection.deleteMany({ actor: uid }),
    ]);
    if (target) await User.deleteOne({ _id: target._id });
    console.log('(test data cleaned up)');
  }
  socketGateway?.close();
  server?.close();
  await disconnectDb();
}
