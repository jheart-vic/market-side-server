// Live end-to-end test of the ledger / user / referral / notification /
// announcement / audit services against the configured MongoDB (.env).
// Creates throwaway users, moves money through every ledger operation, then
// deletes everything it made. Run with `npm run test:services`.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { Captcha } from '../src/models/Captcha.js';
import { User } from '../src/models/User.js';
import { Wallet } from '../src/models/Wallet.js';
import { Session } from '../src/models/Session.js';
import { Notification } from '../src/models/Notification.js';
import { Referral } from '../src/models/Referral.js';
import { Announcement } from '../src/models/Announcement.js';
import { LedgerEntry } from '../src/models/LedgerEntry.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { Setting } from '../src/models/Setting.js';
import { Trade } from '../src/models/Trade.js';
import { Signal } from '../src/models/Signal.js';
import { SignalPosition } from '../src/models/SignalPosition.js';
import { Deposit } from '../src/models/Deposit.js';
import { Withdrawal } from '../src/models/Withdrawal.js';
import { sha256 } from '../src/utils/tokens.js';
import { decimal128ToBigInt, bigIntToDecimal128 } from '../src/utils/money.js';
import { lagosDayKey, lagosWeekday } from '../src/utils/time.js';
import * as auth from '../src/services/auth.service.js';
import * as ledger from '../src/services/ledger.service.js';
import * as userService from '../src/services/user.service.js';
import * as referralService from '../src/services/referral.service.js';
import * as notificationService from '../src/services/notification.service.js';
import * as announcementService from '../src/services/announcement.service.js';
import * as auditService from '../src/services/audit.service.js';
import * as priceService from '../src/services/price.service.js';
import * as tradeService from '../src/services/trade.service.js';
import * as signalService from '../src/services/signal.service.js';
import * as paymentService from '../src/services/payment.service.js';
import * as depositService from '../src/services/deposit.service.js';
import * as withdrawalService from '../src/services/withdrawal.service.js';
import * as settingsService from '../src/services/settings.service.js';

async function seedCaptcha(purpose, answer = 'abc12') {
  const c = await Captcha.create({
    answerHash: sha256(answer),
    purpose,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { captchaId: c.id, captchaAnswer: answer };
}

async function balances(userId, currency) {
  const w = await Wallet.findOne({ user: userId, currency });
  return { balance: decimal128ToBigInt(w.balance), held: decimal128ToBigInt(w.held) };
}

const stamp = Date.now().toString().slice(-9);
const meta = { ip: '127.0.0.1', userAgent: 'services-e2e' };
const userIds = [];
let announcementId;
let priorRates; // restore any pre-existing configured rates after the test
let priorPaymentSettings; // same for the payment settings row

async function makeUser(tag, extra = {}) {
  const reg = await auth.register({
    phone: `+23480${(Number(stamp.slice(0, 8)) + userIds.length).toString().padStart(8, '0')}`,
    email: `svc-e2e-${tag}-${stamp}@test.local`,
    username: `svc_${tag}_${stamp}`,
    fullName: `Service E2E ${tag}`,
    password: 'Passw0rd!x',
    ...(await seedCaptcha('register')),
    ...extra,
    meta,
  });
  userIds.push(reg.user.id);
  return User.findById(reg.user.id);
}

try {
  await connectDb();

  // --- fixture users: admin, referrer (upline), trader (downline) ---
  const admin = await makeUser('admin');
  await User.updateOne({ _id: admin._id }, { $set: { role: 'admin' } });
  admin.role = 'admin';
  const referrer = await makeUser('referrer');
  const trader = await makeUser('trader', { referralCode: referrer.referralCode });
  assert.equal(String(trader.uplines[0]), String(referrer._id), 'referral tree linked');
  console.log('✓ fixtures: admin + referrer + referred trader');

  // --- ledger: credit / debit / insufficient funds ---
  const NGN = 'NGN';
  await ledger.credit({ user: trader._id, currency: NGN, amount: 1_000_000n, type: 'deposit', narration: 'test deposit ₦10,000' });
  assert.deepEqual(await balances(trader._id, NGN), { balance: 1_000_000n, held: 0n });
  await assert.rejects(
    ledger.debit({ user: trader._id, currency: NGN, amount: 2_000_000n, type: 'trade' }),
    /Insufficient funds/,
  );
  assert.deepEqual(await balances(trader._id, NGN), { balance: 1_000_000n, held: 0n }, 'failed debit left balance untouched');
  console.log('✓ ledger credit + insufficient-funds debit rejected atomically');

  // --- ledger: hold → partial release → settle ---
  await ledger.hold({ user: trader._id, currency: NGN, amount: 200_000n, type: 'withdrawal_hold' });
  assert.deepEqual(await balances(trader._id, NGN), { balance: 800_000n, held: 200_000n });
  await ledger.releaseHold({ user: trader._id, currency: NGN, amount: 50_000n });
  assert.deepEqual(await balances(trader._id, NGN), { balance: 850_000n, held: 150_000n });
  await ledger.settleHold({ user: trader._id, currency: NGN, amount: 150_000n, type: 'withdrawal' });
  assert.deepEqual(await balances(trader._id, NGN), { balance: 850_000n, held: 0n });
  console.log('✓ ledger hold / release / settle');

  // --- ledger: NGN→USDT conversion with fee, one atomic group ---
  await ledger.convert({
    user: trader._id,
    from: { currency: NGN, amount: 100_000n },
    to: { currency: 'USDT', amount: 500_000n }, // 0.50 USDT in micro-units
    fee: { amount: 1_000n },
    narration: 'test conversion',
  });
  assert.deepEqual(await balances(trader._id, NGN), { balance: 749_000n, held: 0n });
  assert.equal((await balances(trader._id, 'USDT')).balance, 500_000n);
  console.log('✓ ledger convert (debit + credit + fee share one group)');

  // --- ledger: history + reconcile ---
  const history = await ledger.getHistory(trader._id, { currency: NGN });
  assert.ok(history.items.length >= 6, 'NGN history has all entries');
  assert.ok(history.items.every((e) => /^\d+(\.\d+)?$/.test(e.amount)), 'display amounts are decimal strings');
  const recon = await ledger.reconcile(trader._id);
  assert.equal(recon.mismatches.length, 0, 'wallets reconcile against the ledger');
  console.log('✓ ledger history + reconcile clean');

  // --- referral: rates + commission payout (dollar-denominated platform) ---
  priorRates = (await Setting.findOne({ key: 'referral_rates' }))?.value ?? null;
  assert.deepEqual(await referralService.getRates(), { 1: 10, 2: 2, 3: 1 });
  const paid = await referralService.payCommissions({
    event: 'deposit',
    sourceUser: trader._id,
    baseAmount: 1_000_000n, // $1.00 in micro-USDT
    sourceRef: { kind: 'Deposit' },
  });
  assert.equal(paid.length, 1, 'one upline level paid');
  assert.equal((await balances(referrer._id, 'USDT')).balance, 100_000n, 'L1 got 10% of $1 in USDT');
  const stats = await referralService.getStats(referrer._id);
  assert.equal(stats.totalReferrals, 1);
  assert.equal(stats.currency, 'USDT');
  assert.equal(stats.earningsByLevel[1].amount, '0.1');
  assert.equal(stats.totalEarnings, '0.1');
  const { qr, link } = await referralService.getQrCode(referrer);
  assert.ok(qr.startsWith('data:image/png;base64,') && link.includes(referrer.referralCode));
  await referralService.setRates(admin, { 1: 5, 2: 1, 3: 0.5 });
  assert.deepEqual(await referralService.getRates(), { 1: 5, 2: 1, 3: 0.5 });
  console.log('✓ referral commissions + stats + QR + admin rates');

  // --- user service: KYC lifecycle + freeze + search ---
  await userService.submitKyc(trader._id, [{ kind: 'national_id', url: 'https://files.test/id.png' }]);
  await assert.rejects(userService.submitKyc(trader._id, [{ kind: 'x', url: 'y' }]), /already/i);
  await userService.reviewKyc(admin, trader._id, 'approved');
  assert.equal((await userService.getProfile(trader._id)).kycStatus, 'approved');
  await userService.setAccountStatus(admin, trader._id, 'frozen', 'test freeze');
  assert.equal((await User.findById(trader._id)).status, 'frozen');
  await userService.setAccountStatus(admin, trader._id, 'active');
  const search = await userService.searchUsers({ q: `svc-e2e-trader-${stamp}` });
  assert.equal(search.items.length, 1);
  console.log('✓ user KYC submit/approve + freeze/unfreeze + search');

  // --- notifications: list / unread / mark read ---
  const list1 = await notificationService.list(trader._id);
  assert.ok(list1.unreadCount >= 1, 'trader has unread notifications (kyc decision at least)');
  const firstUnread = list1.items.find((n) => !n.read);
  await notificationService.markRead(trader._id, firstUnread.id);
  const list2 = await notificationService.list(trader._id);
  assert.equal(list2.unreadCount, list1.unreadCount - 1);
  await notificationService.markAllRead(trader._id);
  assert.equal((await notificationService.list(trader._id)).unreadCount, 0);
  const adminFeed = await notificationService.adminList();
  assert.ok(adminFeed.items.some((n) => n.type === 'kyc_submitted'));
  console.log('✓ notifications list / markRead / markAllRead / admin feed');

  // --- announcements: create + fan-out + lists + delete ---
  const ann = await announcementService.create(admin, { title: `E2E notice ${stamp}`, body: 'Test announcement body.' });
  announcementId = ann.id;
  const fanned = await Notification.find({ 'meta.announcementId': ann.id });
  assert.ok(fanned.length >= 2, 'announcement fanned out to the test users at least');
  const pub = await announcementService.listPublished();
  assert.ok(pub.items.some((a) => a.id === ann.id));
  console.log('✓ announcement create + fan-out + published list');

  // --- audit: rows exist and feed filters ---
  const feed = await auditService.feed({ action: 'user.freeze' });
  assert.ok(feed.items.length >= 1, 'freeze action audited');
  const kycAudit = await auditService.feed({ actor: admin._id });
  assert.ok(kycAudit.items.some((r) => r.action === 'kyc.approve'));
  console.log('✓ audit feed filters by action and actor');

  // --- payment gateway: MD5 signature round-trip incl. "100.00" raw preservation ---
  const cbParams = {
    merchantId: 'M1',
    merchantOrderId: 'MSTESTSIG',
    orderId: 'G1',
    orderStatus: 3,
    signType: 'MD5',
    standbyObject: '{}',
    transAmt: '100.00',
  };
  const cbSign = paymentService.signParams(cbParams);
  const rawCb = `{"merchantId":"M1","merchantOrderId":"MSTESTSIG","orderId":"G1","orderStatus":3,"signType":"MD5","standbyObject":"{}","transAmt":100.00,"sign":"${cbSign}"}`;
  const parsedCb = JSON.parse(rawCb); // transAmt becomes 100 — raw body must rescue "100.00"
  assert.equal(paymentService.verifyCallback(parsedCb, rawCb), true, 'valid signature accepted');
  assert.equal(
    paymentService.verifyCallback({ ...parsedCb, orderStatus: 5 }, rawCb.replace('"orderStatus":3', '"orderStatus":5')),
    false,
    'tampered payload rejected',
  );
  console.log('✓ gateway signature sign/verify round-trip (raw decimal preserved)');

  // --- platform settings + Lagos withdrawal window ---
  priorPaymentSettings = (await Setting.findOne({ key: 'payment_settings' }))?.value ?? null;
  const updatedSettings = await settingsService.setSettings(admin, { min_deposit_usd: 20 });
  assert.equal(updatedSettings.min_deposit_usd, 20);
  assert.equal(await settingsService.getSetting('withdrawal_daily_limit'), 1, 'defaults merge');
  await assert.rejects(settingsService.setSettings(admin, { nope: 1 }), /Unknown settings/);
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const monNoon = new Date('2026-07-06T11:00:00Z'); // 12:00 Lagos
  const today = DAYS[lagosWeekday(monNoon)];
  const otherDay = DAYS[(lagosWeekday(monNoon) + 3) % 7];
  assert.equal(withdrawalService.isWithinWithdrawalWindow(`${today} to ${today}`, '10:00 AM – 05:00 PM', monNoon), true);
  assert.equal(withdrawalService.isWithinWithdrawalWindow(`${otherDay},${otherDay}`, '10:00 AM – 05:00 PM', monNoon), false);
  assert.equal(withdrawalService.isWithinWithdrawalWindow(`${today} to ${today}`, '01:00 PM – 05:00 PM', monNoon), false);
  console.log('✓ platform settings persist + Lagos withdrawal-window parser');

  // --- deposit callback: NGN credited + auto-converted to USD at the LOCKED rate, idempotent ---
  const rateKobo = 150_000n; // locked at intent: ₦1,500 per $1
  const depRef = `MSTESTDEP${stamp}`;
  const dep = await Deposit.create({
    user: trader._id,
    gateway: 'beidou',
    reference: depRef,
    amount: bigIntToDecimal128(1_500_000n), // ₦15,000 requested
    amountUsd: bigIntToDecimal128(10_000_000n), // $10 quoted
    exchangeRate: bigIntToDecimal128(rateKobo),
  });
  const ngnBeforeDep = (await balances(trader._id, NGN)).balance;
  const usdtBeforeDep = (await balances(trader._id, 'USDT')).balance;
  const refBeforeDep = (await balances(referrer._id, 'USDT')).balance;
  const depCb = { merchantOrderId: depRef, orderStatus: 3, transAmt: '15000.00', orderId: 'GW1' };
  await depositService.handleCallback(depCb);
  assert.equal((await Deposit.findById(dep._id)).status, 'success');
  assert.equal((await balances(trader._id, 'USDT')).balance, usdtBeforeDep + 10_000_000n, '$10 credited at locked rate');
  assert.equal((await balances(trader._id, NGN)).balance, ngnBeforeDep, 'NGN wallet nets to zero');
  await depositService.handleCallback(depCb); // gateway retry
  assert.equal((await balances(trader._id, 'USDT')).balance, usdtBeforeDep + 10_000_000n, 'retry did not double-credit');
  assert.equal(
    (await balances(referrer._id, 'USDT')).balance,
    refBeforeDep + 500_000n,
    'L1 commission on the USD amount (5% per rates set earlier)',
  );
  console.log('✓ deposit callback → NGN→USD ledger credit (idempotent) + referral commission');

  // --- withdrawal callbacks: failed → refund, completed → hold settled ---
  async function seedWithdrawal() {
    const wid = new mongoose.Types.ObjectId();
    await ledger.hold({
      user: trader._id,
      currency: 'USDT',
      amount: 5_000_000n,
      type: 'withdrawal_hold',
      ref: { kind: 'Withdrawal', item: wid },
    });
    return Withdrawal.create({
      _id: wid,
      user: trader._id,
      amount: bigIntToDecimal128(675_000n), // ₦6,750 payout
      fee: bigIntToDecimal128(500_000n),
      amountUsd: bigIntToDecimal128(5_000_000n), // $5 gross held
      netAmountUsd: bigIntToDecimal128(4_500_000n),
      exchangeRate: bigIntToDecimal128(rateKobo),
      bank: { bankCode: 'OPay', bankName: 'OPay', accountNumber: '0123456789', accountName: 'Svc E2E' },
      status: 'approved',
    });
  }

  const wFail = await seedWithdrawal();
  const beforeFail = await balances(trader._id, 'USDT');
  await withdrawalService.handleCallback({ merchantOrderId: `MS${wFail.id}`, orderStatus: 5, remark: 'test failure' });
  const afterFail = await balances(trader._id, 'USDT');
  assert.equal((await Withdrawal.findById(wFail._id)).status, 'rejected');
  assert.equal(afterFail.balance, beforeFail.balance + 5_000_000n, 'failed payout refunded the hold');
  assert.equal(afterFail.held, beforeFail.held - 5_000_000n);

  const wPaid = await seedWithdrawal();
  const beforePaid = await balances(trader._id, 'USDT');
  await withdrawalService.handleCallback({ merchantOrderId: `MS${wPaid.id}`, orderStatus: 3, orderId: 'GW2' });
  const afterPaid = await balances(trader._id, 'USDT');
  assert.equal((await Withdrawal.findById(wPaid._id)).status, 'paid');
  assert.equal(afterPaid.balance, beforePaid.balance, 'paid payout leaves balance untouched');
  assert.equal(afterPaid.held, beforePaid.held - 5_000_000n, 'hold settled out');
  const reconPay = await ledger.reconcile(trader._id);
  assert.equal(reconPay.mismatches.length, 0, 'wallets reconcile after deposit + withdrawals');
  console.log('✓ withdrawal callbacks: fail → refund, complete → settle; reconcile clean');

  // --- price service + trading + signals (live provider; tolerate network failure) ---
  try {
    const prices = await priceService.getPrices();
    assert.ok(prices.length >= 1 && prices.every((p) => /^\d+(\.\d+)?$/.test(p.priceUsd)));
    assert.ok(prices.every((p) => /^\d+(\.\d+)?$/.test(p.priceNgn)));
    const btcKobo = await priceService.getPriceKobo('BTC/NGN');
    const btcMicro = await priceService.getPriceMicroUsd('BTC');
    assert.equal(typeof btcKobo, 'bigint');
    assert.equal(typeof btcMicro, 'bigint');
    console.log(`✓ price service live (BTC = $${prices.find((p) => p.asset === 'BTC')?.priceUsd} / ₦${prices.find((p) => p.asset === 'BTC')?.priceNgn})`);

    // --- trade: fund $100, buy $50 of BTC, sell it all back, P/L ---
    await ledger.credit({ user: trader._id, currency: 'USDT', amount: 100_000_000n, type: 'deposit', narration: 'test fund $100' });
    const usdtStart = (await balances(trader._id, 'USDT')).balance;
    const buy = await tradeService.executeTrade(trader, { asset: 'BTC', side: 'buy', amount: '50' });
    assert.equal(buy.side, 'buy');
    assert.ok(Number(buy.baseAmount) > 0, 'buy produced BTC');
    assert.equal((await balances(trader._id, 'USDT')).balance, usdtStart - 50_000_000n, 'buy debited exactly $50 (net + fee)');
    const sell = await tradeService.executeTrade(trader, { asset: 'BTC', side: 'sell', amount: buy.baseAmount });
    assert.equal((await balances(trader._id, 'BTC')).balance, 0n, 'BTC fully sold');
    assert.ok(sell.realizedPnl !== null, 'sell computed realized P/L (FIFO)');
    const pnl = await tradeService.getPnl(trader._id);
    assert.ok([pnl.realized, pnl.unrealized, pnl.total].every((v) => typeof v === 'string'));
    console.log(`✓ trade buy/sell round-trip (realized P/L $${sell.realizedPnl}, ≈ -fees)`);

    // --- signals: create → release → contract order → duplicate rejected → settle ---
    const sig = await signalService.createSignal(admin, {
      pair: 'BCH/NGN',
      direction: 'call',
      returnPct: 8,
      minStake: '1',
      maxStake: '100',
      durationSeconds: 60,
      tradingStart: '00:00',
      tradingEnd: '23:59',
      releaseDay: lagosDayKey(),
    });
    await Signal.updateOne({ _id: sig.id }, { $set: { status: 'released', releasedAt: new Date() } });
    const usdtBefore = (await balances(trader._id, 'USDT')).balance;
    const pos = await signalService.placeOrder(trader._id, sig.id, { stake: '10', direction: 'call' });
    assert.equal((await balances(trader._id, 'USDT')).held, 10_000_000n, '$10 stake held');
    assert.ok(/^\d+(\.\d+)?$/.test(pos.entryPrice), 'entry price snapshotted');
    await assert.rejects(signalService.placeOrder(trader._id, sig.id, { stake: '10', direction: 'put' }), /already/i);
    await SignalPosition.updateOne({ _id: pos.id }, { $set: { settlesAt: new Date(Date.now() - 1000) } });
    const sweep = await signalService.settleDuePositions();
    assert.ok(sweep.settled >= 1, 'settlement sweep settled the position');
    const settledPos = await SignalPosition.findById(pos.id);
    assert.equal(settledPos.status, 'settled');
    assert.ok(['win', 'lose'].includes(settledPos.outcome));
    const after = await balances(trader._id, 'USDT');
    assert.equal(after.held, 0n, 'hold consumed');
    if (settledPos.outcome === 'win') {
      assert.equal(after.balance, usdtBefore + 800_000n, 'win pays stake + 8%');
    } else {
      assert.equal(after.balance, usdtBefore - 10_000_000n, 'loss forfeits the stake');
    }
    const recon2 = await ledger.reconcile(trader._id);
    assert.equal(recon2.mismatches.length, 0, 'wallets still reconcile after trades + signals');
    console.log(`✓ signal contract order + settlement (outcome: ${settledPos.outcome}) + reconcile clean`);
  } catch (err) {
    if (err?.message?.includes('Price')) {
      console.warn(`⚠ price provider unreachable, trade/signal checks skipped: ${err.message}`);
    } else {
      throw err;
    }
  }

  console.log('\nAll service e2e checks passed.');
} finally {
  // Cleanup — ledger/audit models are append-only by design, so test rows are
  // removed at the collection level (bypasses the immutability hooks on purpose).
  try {
    if (userIds.length) {
      const objectIds = userIds.map((id) => new mongoose.Types.ObjectId(id));
      await Session.deleteMany({ user: { $in: userIds } });
      await Notification.deleteMany({
        $or: [{ user: { $in: userIds } }, { audience: 'admin', 'meta.user': { $in: userIds } }],
      });
      await Referral.deleteMany({ beneficiary: { $in: userIds } });
      await Deposit.deleteMany({ user: { $in: userIds } });
      await Withdrawal.deleteMany({ user: { $in: userIds } });
      await Trade.deleteMany({ user: { $in: userIds } });
      await SignalPosition.deleteMany({ user: { $in: userIds } });
      await Signal.deleteMany({ createdBy: { $in: userIds } });
      await Wallet.deleteMany({ user: { $in: userIds } });
      await LedgerEntry.collection.deleteMany({ user: { $in: objectIds } });
      await AuditLog.collection.deleteMany({ actor: { $in: objectIds } });
      await User.deleteMany({ _id: { $in: userIds } });
    }
    if (announcementId) {
      await Announcement.deleteOne({ _id: announcementId });
      await Notification.deleteMany({ 'meta.announcementId': announcementId });
    }
    // restore whatever referral rates / payment settings existed before the test
    if (priorRates) {
      await Setting.updateOne({ key: 'referral_rates' }, { $set: { value: priorRates } }, { upsert: true });
    } else {
      await Setting.deleteOne({ key: 'referral_rates' });
    }
    if (priorPaymentSettings) {
      await Setting.updateOne({ key: 'payment_settings' }, { $set: { value: priorPaymentSettings } }, { upsert: true });
    } else {
      await Setting.deleteOne({ key: 'payment_settings' });
    }
  } catch (cleanupErr) {
    console.error('Cleanup failed:', cleanupErr);
  }
  await disconnectDb();
}
