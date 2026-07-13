// PaymentGateway service (SPEC §2.3/§2.4) — client for the Beidou-style
// MD5-signed gateway (env.PG_*), mirroring the client's proven integration.
//
// Signing rule (from the integration doc):
//   1. Take every request parameter EXCEPT `sign` (skip null/undefined).
//   2. Sort the keys in ascending ASCII order.
//   3. Concatenate as  key1=value1&key2=value2&...&keyN=valueN
//   4. Append  &<SECRET_KEY>  at the very end.
//   5. MD5, hex, lowercase → `sign`.
//
// The same rule verifies inbound callbacks (their plaintext also includes
// `signType`, excluding only `sign`). Callback verification reads decimal
// amounts from the RAW request body because JSON.parse turns 100.00 into 100
// and would break the signature. Callbacks must be answered with the literal
// text "success" or the gateway retries 8 times.

import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const CFG = {
  baseUrl: (env.PG_BASE_URL ?? '').replace(/\/+$/, ''),
  merchantId: env.PG_MERCHANT_ID ?? '',
  secret: env.PG_SECRET_KEY ?? '',
  countryCode: env.PG_COUNTRY_CODE,
  depositPayType: env.PG_DEPOSIT_PAYTYPE,
  withdrawPayType: env.PG_WITHDRAW_PAYTYPE,
  callbackBaseUrl: (env.PG_CALLBACK_BASE_URL ?? '').replace(/\/+$/, ''),
};

// Resource paths from the doc's "Full address" column (baseUrl ends with /api/order)
const PATHS = {
  balance: '/amount/balance',
  createCollection: '/api/payOrder/publicCreatePayOrder',
  queryCollection: '/api/payOrder/queryPayOrder',
  createPayout: '/api/order/publicWithdrawal',
  queryPayout: '/api/order/queryWithdrawalOrder',
};

export const COLLECTION_STATUS = { INIT: 0, PENDING: 1, COMPLETED: 3, REFUNDED: 4, FAILED: 5 };
export const PAYOUT_STATUS = { PROCESSING: 1, FROZEN: 2, COMPLETED: 3, REFUNDED: 4, FAILED: 5 };

export function isConfigured() {
  return Boolean(CFG.baseUrl && CFG.merchantId && CFG.secret);
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/** Plaintext: sorted key=value pairs joined by &, secret appended. Skips `sign` and null/undefined. */
function buildPlaintext(params, secret) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign')
    .filter((k) => params[k] !== null && params[k] !== undefined)
    .sort();
  return keys.map((k) => `${k}=${String(params[k])}`).join('&') + '&' + secret;
}

const md5 = (str) => crypto.createHash('md5').update(str, 'utf8').digest('hex'); // lowercase hex

/** Sign an outgoing request payload. */
export function signParams(params) {
  return md5(buildPlaintext(params, CFG.secret));
}

/** Pull the raw numeric token for a key out of the raw JSON text (preserves "100.00"). */
function extractRawNumber(rawBody, key) {
  if (!rawBody || typeof rawBody !== 'string') return null;
  const m = rawBody.match(new RegExp(`"${key}"\\s*:\\s*("?)([0-9]+(?:\\.[0-9]+)?)\\1`));
  return m ? m[2] : null;
}

/**
 * Verify an inbound callback signature. `rawBody` is the raw JSON text of the
 * request (req.rawBody, captured in app.js) so decimal formatting survives.
 */
export function verifyCallback(parsedBody, rawBody) {
  if (!parsedBody?.sign) return false;

  const params = { ...parsedBody };
  delete params.sign;

  const rawTransAmt = extractRawNumber(rawBody, 'transAmt');
  if (rawTransAmt !== null) params.transAmt = rawTransAmt;

  const expected = md5(buildPlaintext(params, CFG.secret));
  const provided = String(parsedBody.sign).toLowerCase();
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function post(path, payload) {
  if (!isConfigured()) throw new Error('Payment gateway env (PG_*) is not configured');

  const body = { ...payload, sign: signParams(payload) };
  const res = await fetch(CFG.baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Gateway responded ${res.status} for ${path}`);
  return res.json(); // { code, msg, data }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a collection (deposit) order. `amount` is whole naira.
 * Returns { ok, payUrl, raw } — payUrl is the hosted checkout page.
 */
export async function createCollectionOrder({ merchantOrderId, amount, ip, orderRemark }) {
  const payload = {
    merchantId: CFG.merchantId,
    merchantOrderId,
    transAmt: amount,
    payType: CFG.depositPayType,
    countryCode: CFG.countryCode,
    ip: ip || '127.0.0.1',
  };
  if (orderRemark) payload.orderRemark = orderRemark;
  if (CFG.callbackBaseUrl) payload.callbackUrl = `${CFG.callbackBaseUrl}/api/payments/deposit/callback`;

  const raw = await post(PATHS.createCollection, payload);
  return { ok: raw?.code === 200 && Boolean(raw?.data), payUrl: raw?.data, raw };
}

/**
 * Create a payout (withdrawal) order. `amount` must be WHOLE naira (Nigeria rule).
 * Returns { ok, raw }.
 */
export async function createPayoutOrder({ merchantOrderId, amount, account, name, bnkCode, ip, remark }) {
  const payload = {
    merchantId: CFG.merchantId,
    merchantOrderId,
    transAmt: amount,
    account,
    name,
    bnkCode,
    payType: CFG.withdrawPayType,
    countryCode: CFG.countryCode,
    ip: ip || '127.0.0.1',
  };
  if (remark) payload.remark = remark;
  if (CFG.callbackBaseUrl) payload.callbackUrl = `${CFG.callbackBaseUrl}/api/payments/withdraw/callback`;

  const raw = await post(PATHS.createPayout, payload);
  if (raw?.code !== 200) {
    // Log the submit IP + gateway message so payout rejections (e.g. 该ip禁止访问)
    // are diagnosable from the exact values sent.
    logger.warn(
      { ip: payload.ip, merchantOrderId: payload.merchantOrderId, code: raw?.code, msg: raw?.msg },
      'Gateway payout rejected',
    );
  }
  return { ok: raw?.code === 200, raw };
}

export function queryCollectionOrder(merchantOrderId) {
  return post(PATHS.queryCollection, { merchantId: CFG.merchantId, merchantOrderId });
}

export function queryPayoutOrder(merchantOrderId) {
  return post(PATHS.queryPayout, { merchantId: CFG.merchantId, merchantOrderId });
}

/** Merchant float — shared with every project on this merchant account. */
export async function getBalance() {
  const raw = await post(PATHS.balance, { merchantId: CFG.merchantId, countryCode: CFG.countryCode });
  if (raw?.code !== 200) {
    logger.warn({ raw }, 'Gateway balance query failed');
  }
  return raw;
}
