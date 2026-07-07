// PriceService (SPEC §2.5) — provider abstraction (CoinGecko seed; Binance/CMC
// swappable behind the same exports) + in-process cache. Every MARKET_ASSET is
// quoted in BOTH dollars (platform display + trade execution) and NGN (signal
// entry/settle snapshots + the deposit/withdrawal conversion rate via USDT/NGN).
// Money-math reads return integer BigInts: getPriceMicroUsd (micro-USDT per
// whole unit) and getPriceKobo (kobo per whole unit); display prices are
// decimal strings. Change/volume/OHLC are display-only and stay plain numbers.

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { MARKET_ASSETS, PLATFORM_CURRENCY } from '../config/constants.js';
import { toSmallestUnits, fromSmallestUnits } from '../utils/money.js';

const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  BNB: 'binancecoin',
  BCH: 'bitcoin-cash',
};
const ID_TO_ASSET = Object.fromEntries(Object.entries(COINGECKO_IDS).map(([a, id]) => [id, a]));
const OHLC_DAYS = [1, 7, 14, 30, 90, 180, 365];

let cache = { updatedAt: 0, quotes: new Map() }; // asset → quote
let inflightRefresh = null;
const ohlcCache = new Map(); // `${asset}:${days}` → { at, data }
const listeners = new Set();

async function fetchJson(path) {
  const headers = { accept: 'application/json' };
  if (env.COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = env.COINGECKO_API_KEY;
  const res = await fetch(`${env.COINGECKO_BASE_URL}${path}`, { headers });
  if (!res.ok) throw new Error(`Price provider responded ${res.status} for ${path}`);
  return res.json();
}

/**
 * Provider float → integer smallest units. Prices are market data, not
 * balances; this is the single place floats are rounded into money units.
 */
function floatToUnits(value, currency, decimals) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Provider returned unusable ${currency} price: ${value}`);
  }
  return toSmallestUnits(value.toFixed(decimals), currency);
}

function assertKnownAsset(asset) {
  if (!MARKET_ASSETS.includes(asset)) {
    throw ApiError.badRequest(`Unknown asset: ${asset}`, 'UNKNOWN_ASSET');
  }
}

// ---------------------------------------------------------------------------
// Cache refresh
// ---------------------------------------------------------------------------

/** Fetch fresh USD + NGN quotes for all assets; called by the price-refresh job and on stale reads. */
export async function refreshCache() {
  const ids = Object.values(COINGECKO_IDS).join(',');
  const data = await fetchJson(
    `/simple/price?ids=${ids}&vs_currencies=usd,ngn&include_24hr_change=true&include_24hr_vol=true`,
  );

  const quotes = new Map();
  const now = new Date();
  for (const [id, quote] of Object.entries(data)) {
    const asset = ID_TO_ASSET[id];
    if (!asset || typeof quote?.usd !== 'number' || typeof quote?.ngn !== 'number') continue;
    quotes.set(asset, {
      asset,
      usdMicro: floatToUnits(quote.usd, PLATFORM_CURRENCY, 6), // micro-USDT per whole unit
      ngnKobo: floatToUnits(quote.ngn, 'NGN', 2), // kobo per whole unit
      change24hPct: typeof quote.usd_24h_change === 'number' ? quote.usd_24h_change : null,
      volume24hUsd: typeof quote.usd_24h_vol === 'number' ? quote.usd_24h_vol : null,
      updatedAt: now,
    });
  }
  if (quotes.size === 0) throw new Error('Price provider returned no usable quotes');

  cache = { updatedAt: Date.now(), quotes };
  const snapshot = getCachedPrices();
  for (const cb of listeners) {
    try {
      cb(snapshot);
    } catch (err) {
      logger.warn({ err }, 'Price update listener threw');
    }
  }
  return snapshot;
}

/** Refresh when stale, deduping concurrent callers; serves stale data if the provider is down. */
async function ensureFresh() {
  const maxAgeMs = env.PRICE_REFRESH_SECONDS * 1000;
  if (Date.now() - cache.updatedAt < maxAgeMs) return;

  inflightRefresh ??= refreshCache().finally(() => {
    inflightRefresh = null;
  });
  try {
    await inflightRefresh;
  } catch (err) {
    if (cache.quotes.size === 0) {
      throw new ApiError(503, 'Price feed unavailable', 'PRICES_UNAVAILABLE');
    }
    logger.warn({ err }, 'Price refresh failed; serving stale cache');
  }
}

async function freshQuote(asset) {
  assertKnownAsset(asset);
  await ensureFresh();
  const quote = cache.quotes.get(asset);
  if (!quote) throw new ApiError(503, `No price for ${asset}`, 'PRICES_UNAVAILABLE');
  return quote;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function toDisplay(quote) {
  return {
    asset: quote.asset,
    priceUsd: fromSmallestUnits(quote.usdMicro, PLATFORM_CURRENCY), // dollars — primary display
    priceNgn: fromSmallestUnits(quote.ngnKobo, 'NGN'),
    change24hPct: quote.change24hPct,
    volume24hUsd: quote.volume24hUsd,
    updatedAt: quote.updatedAt,
  };
}

/** Current cache as JSON-safe display objects (no BigInts), without refreshing. */
export function getCachedPrices() {
  return [...cache.quotes.values()].map(toDisplay);
}

/** All assets: dollar-first display quotes — refreshes if stale. */
export async function getPrices() {
  await ensureFresh();
  return getCachedPrices();
}

export async function getPrice(asset) {
  return toDisplay(await freshQuote(asset));
}

/** Money-math read for trades: micro-USDT per whole unit of the asset (BigInt). */
export async function getPriceMicroUsd(asset) {
  return (await freshQuote(asset)).usdMicro;
}

/** Money-math read for signal snapshots + NGN conversion: kobo per whole unit (BigInt). Accepts "BCH/NGN" or "BCH". */
export async function getPriceKobo(pairOrAsset) {
  const asset = String(pairOrAsset).split('/')[0];
  return (await freshQuote(asset)).ngnKobo;
}

/** Candlestick data in dollars (display-only). days ∈ 1|7|14|30|90|180|365. */
export async function getOhlc(asset, { days = 1 } = {}) {
  assertKnownAsset(asset);
  const parsedDays = Number(days);
  if (!OHLC_DAYS.includes(parsedDays)) {
    throw ApiError.badRequest(`days must be one of ${OHLC_DAYS.join(', ')}`, 'INVALID_OHLC_RANGE');
  }

  const key = `${asset}:${parsedDays}`;
  const cached = ohlcCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.data;

  const raw = await fetchJson(`/coins/${COINGECKO_IDS[asset]}/ohlc?vs_currency=usd&days=${parsedDays}`);
  const data = raw.map(([time, open, high, low, close]) => ({ time, open, high, low, close }));
  ohlcCache.set(key, { at: Date.now(), data });
  return data;
}

/** CoinGecko exposes no order book; swap the provider (Binance) to enable depth. */
export async function getDepth(asset) {
  assertKnownAsset(asset);
  throw new ApiError(501, 'Market depth is not available from the current price provider', 'DEPTH_UNAVAILABLE');
}

/** Socket gateway hook: cb(prices) after every successful refresh. Returns unsubscribe. */
export function onPriceUpdate(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
