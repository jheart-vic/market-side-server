// HTTP end-to-end test: boots the real Express app on an ephemeral port and
// drives the auth + wallet routes over fetch — cookies, CSRF, validation and
// all. Test data is deleted afterwards. Run with `npm run test:http`.
import assert from 'node:assert/strict';
import { app } from '../src/app.js';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { Captcha } from '../src/models/Captcha.js';
import { User } from '../src/models/User.js';
import { Wallet } from '../src/models/Wallet.js';
import { Session } from '../src/models/Session.js';
import { Notification } from '../src/models/Notification.js';
import { sha256 } from '../src/utils/tokens.js';

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
let server;

try {
  await connectDb();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  // health
  const health = await api('/api/health');
  assert.equal(health.status, 200);
  console.log('✓ GET /api/health');

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
      password: 'Passw0rd!x',
      securityQuestion: 'Favourite colour?',
      securityAnswer: 'blue',
      ...(await seedCaptcha('register')),
    },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  userId = reg.body.user.id;
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
  assert.equal(wallets.body.wallets.length, 4);
  const ngn = await api('/api/wallets/NGN');
  assert.equal(ngn.body.wallet.balance, '0');
  const badCur = await api('/api/wallets/DOGE');
  assert.equal(badCur.status, 400);
  console.log('✓ GET /api/wallets + /api/wallets/NGN (DOGE → 400)');

  // logout clears cookies; me becomes 401
  const out = await api('/api/auth/logout', { method: 'POST', csrf: true });
  assert.equal(out.status, 204);
  const meAfter = await api('/api/auth/me');
  assert.equal(meAfter.status, 401);
  console.log('✓ POST /api/auth/logout → 204, cookies cleared, /me → 401');

  console.log('\nALL HTTP E2E CHECKS PASSED');
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
  server?.close();
  await disconnectDb();
}
