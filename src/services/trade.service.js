// TradeService (SPEC §2.6) — instant spot buy/sell against the internal ledger
// at the cached price (PriceService), executed in the platform dollar: buys
// spend USDT, sells return USDT. Both legs + fee are LedgerService entries in
// one Mongo transaction with the Trade row and FIFO cost-basis updates.
// Realized P/L is computed on sells (FIFO against prior buys); unrealized P/L
// comes from open buy remainders at the current price.

import mongoose from 'mongoose';
import { Trade } from '../models/Trade.js';
import { TRADE_ASSETS, PLATFORM_CURRENCY } from '../config/constants.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import {
  CURRENCY_DECIMALS,
  toSmallestUnits,
  fromSmallestUnits,
  bigIntToDecimal128,
  decimal128ToBigInt,
  percentOf,
} from '../utils/money.js';
import * as priceService from './price.service.js';
import * as ledgerService from './ledger.service.js';

const scaleOf = (asset) => 10n ** BigInt(CURRENCY_DECIMALS[asset]);
const pairOf = (asset) => `${asset}/${PLATFORM_CURRENCY}`;

function toDisplay(trade) {
  const [base] = trade.pair.split('/');
  return {
    id: trade.id,
    pair: trade.pair,
    side: trade.side,
    baseAmount: fromSmallestUnits(decimal128ToBigInt(trade.baseAmount), base),
    quoteAmount: fromSmallestUnits(decimal128ToBigInt(trade.quoteAmount), PLATFORM_CURRENCY),
    price: fromSmallestUnits(decimal128ToBigInt(trade.price), PLATFORM_CURRENCY),
    fee: fromSmallestUnits(decimal128ToBigInt(trade.fee), PLATFORM_CURRENCY),
    realizedPnl:
      trade.realizedPnl == null
        ? null
        : fromSmallestUnits(decimal128ToBigInt(trade.realizedPnl), PLATFORM_CURRENCY),
    status: trade.status,
    executedAt: trade.executedAt,
  };
}

/**
 * Consume FIFO cost basis for a sell: walks the user's oldest open buys and
 * returns the dollar cost of `baseUnits`. Base acquired outside trades (e.g.
 * conversions) has no basis row and counts as zero cost.
 */
async function consumeFifoBasis(userId, pair, baseUnits, session) {
  let remainingToConsume = baseUnits;
  let cost = 0n;
  const scale = scaleOf(pair.split('/')[0]);

  const cursor = Trade.find({
    user: userId,
    pair,
    side: 'buy',
    remainingBase: { $gt: 0 },
  })
    .sort({ createdAt: 1 })
    .session(session)
    .cursor();

  for await (const buy of cursor) {
    if (remainingToConsume <= 0n) break;
    const available = decimal128ToBigInt(buy.remainingBase);
    const consumed = available < remainingToConsume ? available : remainingToConsume;
    cost += (consumed * decimal128ToBigInt(buy.price)) / scale;
    remainingToConsume -= consumed;
    await Trade.updateOne(
      { _id: buy._id },
      { $set: { remainingBase: bigIntToDecimal128(available - consumed) } },
      { session },
    );
  }
  return cost; // any un-matched remainder is zero-cost
}

/**
 * Execute an instant trade at the cached price.
 * - buy:  `amount` is dollars to spend (display units, e.g. "50")
 * - sell: `amount` is base asset to sell (display units, e.g. "0.0005")
 */
export async function executeTrade(user, { asset, side, amount }) {
  if (!TRADE_ASSETS.includes(asset)) {
    throw ApiError.badRequest(`Asset must be one of: ${TRADE_ASSETS.join(', ')}`, 'INVALID_ASSET');
  }
  const pair = pairOf(asset);
  const price = await priceService.getPriceMicroUsd(asset); // BigInt, micro-USDT per whole unit
  const scale = scaleOf(asset);
  const userId = user._id ?? user;

  let baseUnits;
  let quoteNet; // the dollar 'trade' leg, fee excluded
  let fee;

  if (side === 'buy') {
    const quoteTotal = toSmallestUnits(amount, PLATFORM_CURRENCY); // dollars the user spends
    fee = percentOf(quoteTotal, env.TRADE_FEE_PCT);
    quoteNet = quoteTotal - fee;
    baseUnits = (quoteNet * scale) / price;
    if (quoteNet <= 0n || baseUnits <= 0n) {
      throw ApiError.badRequest('Amount too small to trade', 'AMOUNT_TOO_SMALL');
    }
  } else if (side === 'sell') {
    baseUnits = toSmallestUnits(amount, asset);
    const proceeds = (baseUnits * price) / scale;
    fee = percentOf(proceeds, env.TRADE_FEE_PCT);
    quoteNet = proceeds;
    if (proceeds <= 0n || proceeds - fee <= 0n) {
      throw ApiError.badRequest('Amount too small to trade', 'AMOUNT_TOO_SMALL');
    }
  } else {
    throw ApiError.badRequest('Side must be buy or sell', 'INVALID_SIDE');
  }

  const session = await mongoose.startSession();
  try {
    let trade;
    await session.withTransaction(async () => {
      const entries =
        side === 'buy'
          ? [
              { user: userId, currency: PLATFORM_CURRENCY, direction: 'debit', amount: quoteNet, type: 'trade' },
              { user: userId, currency: asset, direction: 'credit', amount: baseUnits, type: 'trade' },
              ...(fee > 0n
                ? [{ user: userId, currency: PLATFORM_CURRENCY, direction: 'debit', amount: fee, type: 'fee' }]
                : []),
            ]
          : [
              { user: userId, currency: asset, direction: 'debit', amount: baseUnits, type: 'trade' },
              { user: userId, currency: PLATFORM_CURRENCY, direction: 'credit', amount: quoteNet, type: 'trade' },
              ...(fee > 0n
                ? [{ user: userId, currency: PLATFORM_CURRENCY, direction: 'debit', amount: fee, type: 'fee' }]
                : []),
            ];
      const { groupId } = await ledgerService.post(entries, { session });

      let realizedPnl = null;
      if (side === 'sell') {
        const cost = await consumeFifoBasis(userId, pair, baseUnits, session);
        realizedPnl = quoteNet - fee - cost;
      }

      [trade] = await Trade.create(
        [
          {
            user: userId,
            pair,
            side,
            baseAmount: bigIntToDecimal128(baseUnits),
            quoteAmount: bigIntToDecimal128(quoteNet),
            price: bigIntToDecimal128(price),
            fee: bigIntToDecimal128(fee),
            remainingBase: side === 'buy' ? bigIntToDecimal128(baseUnits) : null,
            realizedPnl: realizedPnl === null ? null : bigIntToDecimal128(realizedPnl),
            ledgerGroupId: groupId,
          },
        ],
        { session },
      );
    });
    return toDisplay(trade);
  } finally {
    await session.endSession();
  }
}

export async function getHistory(userId, { asset, ...query } = {}) {
  const filter = { user: userId };
  if (asset) filter.pair = pairOf(asset);

  const { page, limit, skip } = parsePagination(query);
  const [rows, total] = await Promise.all([
    Trade.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Trade.countDocuments(filter),
  ]);
  return { items: rows.map(toDisplay), meta: paginationMeta(total, page, limit) };
}

/** Dashboard P/L in dollars: realized (sum of sell P/L) + unrealized (open buy remainders at current price). */
export async function getPnl(userId) {
  let realized = 0n;
  const sells = await Trade.find({ user: userId, side: 'sell', realizedPnl: { $ne: null } }).select('realizedPnl');
  for (const t of sells) realized += decimal128ToBigInt(t.realizedPnl);

  let unrealized = 0n;
  const openBuys = await Trade.find({ user: userId, side: 'buy', remainingBase: { $gt: 0 } }).select(
    'pair price remainingBase',
  );
  for (const buy of openBuys) {
    const asset = buy.pair.split('/')[0];
    const current = await priceService.getPriceMicroUsd(asset);
    const remaining = decimal128ToBigInt(buy.remainingBase);
    const scale = scaleOf(asset);
    unrealized += (remaining * (current - decimal128ToBigInt(buy.price))) / scale;
  }

  return {
    currency: PLATFORM_CURRENCY,
    realized: fromSmallestUnits(realized, PLATFORM_CURRENCY),
    unrealized: fromSmallestUnits(unrealized, PLATFORM_CURRENCY),
    total: fromSmallestUnits(realized + unrealized, PLATFORM_CURRENCY),
  };
}
